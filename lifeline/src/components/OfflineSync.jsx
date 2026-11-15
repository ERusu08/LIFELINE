import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import {
  FrameCollector,
  buildSyncData,
  encodeSyncCode,
  isFrame,
  makeFrames,
  readSyncInput,
} from "../utils/offlineSync";

const READER_ID = "lifeline-sync-reader";
const FRAME_MS = 700;

function summarise(tally, from) {
  const parts = [];
  if (tally.created) parts.push(`${tally.created} new request${tally.created === 1 ? "" : "s"}`);
  if (tally.updated) parts.push(`${tally.updated} updated`);
  if (tally.volunteers) parts.push(`${tally.volunteers} volunteer${tally.volunteers === 1 ? "" : "s"}`);
  const had = tally.duplicate + tally.volunteerDuplicates;
  const text = parts.length ? `Received ${parts.join(", ")} from ${from}.` : `Nothing new from ${from}.`;
  const extras = [];
  if (had) extras.push(`${had} item${had === 1 ? "" : "s"} already on this device`);
  if (tally.rejected) extras.push(`${tally.rejected} invalid item${tally.rejected === 1 ? "" : "s"} ignored`);
  return extras.length ? `${text} (${extras.join("; ")}.)` : text;
}

/**
 * Network-free transfer: QR frames on screen, a file, or a text code.
 * Props:
 *  - deviceName, getSyncRequests(), getSyncVolunteers()
 *  - onImport(data) => Promise<tally>   validates + merges (App owns the rules)
 */
export default function OfflineSync({ deviceName, getSyncRequests, getSyncVolunteers, onImport }) {
  const [mode, setMode] = useState("idle"); // idle | show | scan
  const [code, setCode] = useState("");
  const [frames, setFrames] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [counts, setCounts] = useState({ requests: 0, volunteers: 0 });
  const [progress, setProgress] = useState({ have: 0, total: 0 });
  const [scanning, setScanning] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [result, setResult] = useState(null); // { ok, text }
  const [copied, setCopied] = useState(false);

  const scannerRef = useRef(null);
  const collectorRef = useRef(new FrameCollector());
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scannerRef.current?.stop().catch(() => {});
    };
  }, []);

  // Loop through the QR frames.
  useEffect(() => {
    if (mode !== "show" || paused || frames.length < 2) return undefined;
    const timer = setInterval(() => setFrameIndex((index) => (index + 1) % frames.length), FRAME_MS);
    return () => clearInterval(timer);
  }, [mode, paused, frames.length]);

  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (mountedRef.current) setScanning(false);
    if (scanner?.isScanning) await scanner.stop().catch(() => {});
  }, []);

  const importData = useCallback(async (data) => {
    try {
      const tally = await onImport(data);
      setResult({ ok: true, text: summarise(tally, data.deviceName || "another device") });
      return true;
    } catch (error) {
      setResult({ ok: false, text: `Import failed: ${error.message}` });
      return false;
    }
  }, [onImport]);

  async function showCode() {
    setResult(null);
    const requests = getSyncRequests();
    const volunteers = getSyncVolunteers();
    try {
      const encoded = await encodeSyncCode(buildSyncData({ requests, volunteers, deviceName }));
      setCode(encoded);
      setFrames(makeFrames(encoded));
      setFrameIndex(0);
      setPaused(false);
      setCounts({ requests: requests.length, volunteers: volunteers.length });
      setMode("show");
    } catch (error) {
      setResult({ ok: false, text: `Could not build the sync code: ${error.message}` });
    }
  }

  async function handleScanned(text) {
    const value = String(text || "").trim();
    if (busyRef.current) return;

    if (isFrame(value)) {
      const collector = collectorRef.current;
      const outcome = collector.add(value);
      if (outcome === "ignored") return;
      setProgress({ ...collector.progress });
      if (outcome !== "complete") return;
      busyRef.current = true;
      await stopScanner();
      try {
        const data = await readSyncInput(collector.code());
        await importData(data);
      } catch (error) {
        setResult({ ok: false, text: error.message });
      } finally {
        collector.reset();
        busyRef.current = false;
        if (mountedRef.current) setProgress({ have: 0, total: 0 });
      }
      return;
    }

    if (value.startsWith("LS")) {
      busyRef.current = true;
      await stopScanner();
      try {
        await importData(await readSyncInput(value));
      } catch (error) {
        setResult({ ok: false, text: error.message });
      } finally {
        busyRef.current = false;
      }
    }
  }

  async function startScanner() {
    if (!window.isSecureContext) {
      setResult({ ok: false, text: "The camera needs HTTPS (or localhost). Use the https link, or import a file / paste the code instead." });
      return;
    }
    try {
      await stopScanner();
      collectorRef.current.reset();
      setProgress({ have: 0, total: 0 });
      const scanner = new Html5Qrcode(READER_ID, {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
      scannerRef.current = scanner;
      setScanning(true);
      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 15,
          qrbox: (width, height) => {
            const size = Math.floor(Math.min(width, height) * 0.8);
            return { width: size, height: size };
          },
        },
        handleScanned,
        () => {}
      );
    } catch (error) {
      setScanning(false);
      scannerRef.current = null;
      setResult({ ok: false, text: `Camera error: ${error?.message || error}` });
    }
  }

  async function importPasted() {
    setResult(null);
    try {
      const data = await readSyncInput(pasteText);
      if (await importData(data)) setPasteText("");
    } catch (error) {
      setResult({ ok: false, text: error.message });
    }
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setResult(null);
    if (file.size > 400 * 1024) {
      setResult({ ok: false, text: "That file is too large to be a LIFELINE sync file." });
      return;
    }
    try {
      await importData(await readSyncInput(await file.text()));
    } catch (error) {
      setResult({ ok: false, text: error.message });
    }
  }

  async function saveFile() {
    setResult(null);
    try {
      const requests = getSyncRequests();
      const volunteers = getSyncVolunteers();
      const encoded = await encodeSyncCode(buildSyncData({ requests, volunteers, deviceName }));
      const blob = new Blob([encoded], { type: "text/plain" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const safeName = (deviceName || "device").replace(/[^A-Za-z0-9-]+/g, "-");
      link.download = `lifeline-${safeName}.lifeline`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      setResult({ ok: true, text: `Saved ${requests.length} request(s) and ${volunteers.length} volunteer(s) to a file. Send it with AirDrop, Nearby Share or Bluetooth.` });
    } catch (error) {
      setResult({ ok: false, text: `Could not save the file: ${error.message}` });
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => mountedRef.current && setCopied(false), 1500);
    } catch {
      setResult({ ok: false, text: "Copy failed. Select the text and copy it manually." });
    }
  }

  function leave() {
    stopScanner();
    collectorRef.current.reset();
    setProgress({ have: 0, total: 0 });
    setMode("idle");
  }

  return (
    <section className="block offline" data-testid="offline-sync">
      <div className="block-head">
        <h2>Offline sync</h2>
        <span>No Wi-Fi, hotspot or internet needed</span>
      </div>

      <p className="net-status">
        Exchange requests and volunteers between devices with only a camera and screen, or a file.
        Do it on <strong>both</strong> devices to share in both directions.
      </p>

      {mode === "idle" && (
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={showCode}>Show my data as QR</button>
          <button type="button" className="btn" onClick={() => { setResult(null); setMode("scan"); }}>Scan another device</button>
          <button type="button" className="btn" onClick={saveFile}>Save as file</button>
          <label className="btn">
            Import a file
            <input type="file" accept=".lifeline,.txt,text/plain" onChange={importFile} hidden data-testid="sync-file" />
          </label>
        </div>
      )}

      {mode === "show" && (
        <div className="pair-step">
          <h3>Hold this up for the other device to scan</h3>
          <p className="hint">
            {counts.requests} request{counts.requests === 1 ? "" : "s"} and {counts.volunteers} volunteer{counts.volunteers === 1 ? "" : "s"}.
            {frames.length > 1 ? ` The code changes ${frames.length} times in a loop; keep the camera on it until it finishes.` : ""}
          </p>
          <div className="qr-frame">
            <QRCodeSVG
              value={frames[frameIndex] || " "}
              size={340}
              level="L"
              marginSize={4}
              bgColor="#ffffff"
              fgColor="#000000"
              style={{ width: "min(340px, 80vw)", height: "auto", display: "block" }}
            />
          </div>
          <p className="hint" data-testid="sync-frame-counter">Frame {frameIndex + 1} of {frames.length}</p>
          <div className="btn-row">
            {frames.length > 1 && (
              <button type="button" className="btn" onClick={() => setPaused((value) => !value)}>
                {paused ? "Resume" : "Pause"}
              </button>
            )}
            <button type="button" className="btn ghost" onClick={leave}>Done</button>
          </div>
          <details className="fallback">
            <summary>Can't scan? Copy the code or save a file instead</summary>
            <textarea readOnly rows={3} value={code} data-testid="sync-code" onFocus={(event) => event.target.select()} />
            <div className="btn-row">
              <button type="button" className="btn" onClick={copyCode}>{copied ? "Copied" : "Copy code"}</button>
              <button type="button" className="btn" onClick={saveFile}>Save as file</button>
            </div>
          </details>
        </div>
      )}

      {mode === "scan" && (
        <div className="scan-box">
          <div id={READER_ID} className="reader" />
          <div className="btn-row">
            {!scanning ? (
              <button type="button" className="btn primary" onClick={startScanner}>Start camera</button>
            ) : (
              <button type="button" className="btn" onClick={stopScanner}>Stop camera</button>
            )}
            <button type="button" className="btn ghost" onClick={leave}>Back</button>
          </div>
          {progress.total > 0 && (
            <p className="hint" data-testid="sync-progress" role="status">
              Scanned {progress.have} of {progress.total} frames. Keep the camera on the looping code.
            </p>
          )}
          <textarea
            data-testid="sync-input"
            placeholder="Or paste a sync code here"
            rows={3}
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
          />
          <div className="btn-row">
            <button type="button" className="btn" onClick={importPasted} disabled={!pasteText.trim()}>Import code</button>
          </div>
          <p className="hint">Hold the phone 15–25 cm from the screen, brightness up. The frames can be scanned in any order.</p>
        </div>
      )}

      {result && (
        <p
          className={`notice ${result.ok ? "" : "warn"}`}
          role={result.ok ? "status" : "alert"}
          data-testid="sync-result"
          style={{ marginTop: 14, marginBottom: 0 }}
        >
          {result.text}
        </p>
      )}
    </section>
  );
}
