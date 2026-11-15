import { useState, useRef, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import {
  createOffer,
  acceptOffer,
  acceptAnswer,
  encodeSignal,
  decodeSignal,
} from "../utils/peerConnection";
import {
  MAX_HOPS,
  buildMessage,
  parseMessage,
  toWireRequest,
  toWireVolunteer,
} from "../utils/requestSync";

const READER_ID = "lifeline-reader";
const ANSWER_SCAN_TIMEOUT_MS = 3 * 60 * 1000; // answer side: waiting for the other device to scan
const CONNECT_TIMEOUT_MS = 30 * 1000; // offer side: answer applied -> channel must open

function newKey() {
  return Math.random().toString(36).slice(2, 8);
}

function timeLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function scannerConfig() {
  return {
    fps: 15,
    // Scan box = 80% of the shorter side of the video, so it fits any phone.
    qrbox: (width, height) => {
      const size = Math.floor(Math.min(width, height) * 0.8);
      return { width: size, height: size };
    },
    videoConstraints: {
      facingMode: "environment",
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

function newScanner() {
  return new Html5Qrcode(READER_ID, {
    formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
    // Use the phone's native barcode reader when available.
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
}

const STATE_TEXT = {
  "waiting-answer": "Waiting for answer QR",
  "waiting-scan": "Waiting for other device to scan",
  connecting: "Connecting…",
  open: "Connected",
  unstable: "Connection unstable…",
  closed: "Disconnected",
  failed: "Connection failed",
};

/**
 * Owns every WebRTC peer connection and data channel.
 *
 * Props (all callbacks are read through a ref, so they are never stale):
 *  - device: { id, name }                      this device
 *  - onDeviceNameChange(name)
 *  - onMessage(request, meta) => Promise<{ ok, status, error? }>
 *        called for each incoming SOS_REQUEST; App validates + stores it
 *  - onRegisterSender(sender | null)
 *        sender(request) => boolean: true if sent on >= 1 OPEN channel
 *  - onAck(requestId, { key, label })          a peer confirmed it stored a request
 *  - onStatusChange({ peers, openCount })      real connection state
 *  - getSyncRequests() => request[]            shared with every newly opened peer
 *  - onVolunteer(volunteer, meta) => Promise<{ ok, status, volunteer?, error? }>
 *  - onRegisterVolunteerSender(sender | null)  sender(volunteer) => boolean
 *  - getSyncVolunteers() => volunteer[]        shared with every newly opened peer
 */
export default function NetworkPanel(props) {
  const { device, onDeviceNameChange } = props;

  const [mode, setMode] = useState("idle");
  const [qrData, setQrData] = useState("");
  const [scanText, setScanText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [logs, setLogs] = useState([]);
  const [peers, setPeers] = useState([]);
  const [copied, setCopied] = useState(false);

  const peersRef = useRef(new Map()); // key -> peer entry
  const pendingRef = useRef(null); // { key, role } – the pairing in progress
  const scannerRef = useRef(null);
  const mountedRef = useRef(true);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  const log = useCallback((text) => {
    console.log("[LIFELINE network]", text);
    if (!mountedRef.current) return;
    setLogs((previous) => [...previous.slice(-79), `${timeLabel()}  ${text}`]);
  }, []);

  /* ---------- status publishing ---------- */

  const sendTo = useCallback((entry, text) => {
    if (entry.channel?.readyState !== "open") return false;
    try {
      entry.channel.send(text);
      return true;
    } catch (error) {
      log(`Send to ${entry.label} failed: ${error.message}`);
      return false;
    }
  }, [log]);

  const broadcast = useCallback((text, exceptKey = null) => {
    const sentTo = [];
    for (const entry of peersRef.current.values()) {
      if (entry.key === exceptKey) continue;
      if (sendTo(entry, text)) sentTo.push(entry.label);
    }
    return sentTo;
  }, [sendTo]);

  const publish = useCallback(() => {
    const list = [...peersRef.current.values()].map((entry) => ({
      key: entry.key,
      label: entry.label,
      state: entry.state,
    }));
    const openCount = list.filter((p) => p.state === "open").length;

    if (mountedRef.current) setPeers(list);
    propsRef.current.onStatusChange?.({ peers: list, openCount });

    if (openCount > 0) {
      propsRef.current.onRegisterSender?.((request) => {
        try {
          const text = buildMessage("SOS_REQUEST", { request: toWireRequest(request), hops: 0 });
          const sentTo = broadcast(text);
          if (sentTo.length) log(`Sent ${request.id} to ${sentTo.join(", ")}. Waiting for confirmation…`);
          return sentTo.length > 0;
        } catch (error) {
          log(`Could not send ${request?.id}: ${error.message}`);
          return false;
        }
      });
      propsRef.current.onRegisterVolunteerSender?.((volunteer) => {
        try {
          const text = buildMessage("VOLUNTEER", { volunteer: toWireVolunteer(volunteer), hops: 0 });
          return broadcast(text).length > 0;
        } catch (error) {
          log(`Could not send volunteer ${volunteer?.id}: ${error.message}`);
          return false;
        }
      });
    } else {
      propsRef.current.onRegisterSender?.(null);
      propsRef.current.onRegisterVolunteerSender?.(null);
    }
  }, [broadcast, log]);

  /* ---------- peer lifecycle ---------- */

  const clearTimer = (entry) => {
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry) entry.timer = null;
  };

  const setState = useCallback((entry, state) => {
    if (entry.state === state) return;
    entry.state = state;
    publish();
  }, [publish]);

  const closePeer = useCallback((key, reason) => {
    const entry = peersRef.current.get(key);
    if (!entry) return;
    clearTimer(entry);
    entry.closing = true;
    try { entry.channel?.close(); } catch { /* already closed */ }
    try { entry.pc?.close(); } catch { /* already closed */ }
    if (reason) log(reason);
    if (pendingRef.current?.key === key) pendingRef.current = null;
    if (entry.state !== "failed") entry.state = "closed";
    publish();
  }, [log, publish]);

  const removePeer = useCallback((key) => {
    closePeer(key);
    peersRef.current.delete(key);
    publish();
  }, [closePeer, publish]);

  const startTimer = useCallback((entry, ms, message) => {
    clearTimer(entry);
    entry.timer = setTimeout(() => {
      if (entry.state === "open") return;
      entry.state = "failed";
      closePeer(entry.key, message);
      if (pendingRef.current?.key === entry.key || mountedRef.current) setMode("idle");
    }, ms);
  }, [closePeer]);

  const handleIncoming = useCallback(async (entry, raw) => {
    let message;
    try {
      message = parseMessage(raw);
    } catch (error) {
      log(`Rejected message from ${entry.label}: ${error.message}`);
      return;
    }

    if (message.type === "HELLO") {
      if (message.name) entry.label = message.name;
      entry.remoteId = message.deviceId;
      log(`Peer identified as "${entry.label}".`);
      publish();
      return;
    }

    if (message.type === "SOS_ACK") {
      log(`${entry.label} confirmed it saved ${message.id}.`);
      propsRef.current.onAck?.(message.id, { key: entry.key, label: entry.label });
      return;
    }

    if (message.type === "TEST") {
      log(`Message from ${entry.label}: ${message.message}`);
      return;
    }

    if (message.type === "VOLUNTEER") {
      let outcome;
      try {
        outcome = await propsRef.current.onVolunteer?.(message.volunteer, {
          fromKey: entry.key,
          fromLabel: entry.label,
        });
      } catch (error) {
        outcome = { ok: false, error: error.message };
      }
      if (!outcome?.ok) {
        log(`Rejected volunteer from ${entry.label}: ${outcome?.error || "not saved"}`);
        return;
      }
      if (outcome.status === "duplicate") return;
      log(`Volunteer "${outcome.volunteer.name}" received from ${entry.label}.`);
      if (message.hops + 1 <= MAX_HOPS) {
        const text = buildMessage("VOLUNTEER", {
          volunteer: toWireVolunteer(outcome.volunteer),
          hops: message.hops + 1,
        });
        broadcast(text, entry.key);
      }
      return;
    }

    // SOS_REQUEST
    const id = message.request?.id;
    let result;
    try {
      result = await propsRef.current.onMessage?.(message.request, {
        fromKey: entry.key,
        fromLabel: entry.label,
      });
    } catch (error) {
      result = { ok: false, error: error.message };
    }

    if (!result?.ok) {
      log(`Rejected emergency from ${entry.label}: ${result?.error || "not saved"}`);
      return;
    }

    // Acknowledge only AFTER the request is stored on this device.
    sendTo(entry, buildMessage("SOS_ACK", { id }));

    if (result.status === "duplicate") {
      log(`Already had ${id} (from ${entry.label}).`);
      return;
    }

    log(`Received and saved ${id} from ${entry.label}.`);

    // Relay new information to every OTHER connected device (multi-hop mesh).
    if (message.hops + 1 <= MAX_HOPS && result.request) {
      const text = buildMessage("SOS_REQUEST", {
        request: toWireRequest(result.request),
        hops: message.hops + 1,
      });
      const relayed = broadcast(text, entry.key);
      if (relayed.length) log(`Relayed ${id} to ${relayed.join(", ")}.`);
    }
  }, [broadcast, log, publish, sendTo]);

  const attachChannel = useCallback((entry, channel) => {
    entry.channel = channel;

    channel.onopen = () => {
      clearTimer(entry);
      if (pendingRef.current?.key === entry.key) {
        pendingRef.current = null;
        if (mountedRef.current) {
          setMode("idle");
          setQrData("");
        }
      }
      log(`Channel OPEN with ${entry.label}.`);
      setState(entry, "open");

      const me = propsRef.current.device || {};
      sendTo(entry, buildMessage("HELLO", { deviceId: me.id, name: me.name }));

      // Share what this device already knows, so devices that pair late
      // (or reconnect) catch up. Receivers ignore duplicates.
      const backlog = propsRef.current.getSyncRequests?.() || [];
      let shared = 0;
      for (const request of backlog) {
        try {
          if (sendTo(entry, buildMessage("SOS_REQUEST", { request: toWireRequest(request), hops: 0 }))) shared++;
        } catch (error) {
          log(`Skipped ${request.id} during sync: ${error.message}`);
        }
      }
      if (shared) log(`Shared ${shared} saved request(s) with ${entry.label}.`);

      for (const volunteer of propsRef.current.getSyncVolunteers?.() || []) {
        try {
          sendTo(entry, buildMessage("VOLUNTEER", { volunteer: toWireVolunteer(volunteer), hops: 0 }));
        } catch (error) {
          log(`Skipped volunteer ${volunteer.id} during sync: ${error.message}`);
        }
      }
    };

    channel.onclose = () => {
      clearTimer(entry);
      if (!entry.closing) log(`Channel CLOSED with ${entry.label}.`);
      if (entry.state !== "failed") setState(entry, "closed");
    };

    channel.onerror = (event) => {
      const detail = event?.error?.message || "unknown error";
      if (!entry.closing) log(`Channel error with ${entry.label}: ${detail}`);
    };

    channel.onmessage = (event) => {
      handleIncoming(entry, event.data);
    };

    if (channel.readyState === "open") channel.onopen();
  }, [handleIncoming, log, sendTo, setState]);

  const watchPeer = useCallback((entry) => {
    const pc = entry.pc;
    pc.addEventListener("connectionstatechange", () => {
      if (entry.closing) return;
      log(`Connection with ${entry.label}: ${pc.connectionState}`);
      if (pc.connectionState === "connected" && entry.channel?.readyState === "open") {
        setState(entry, "open");
      } else if (pc.connectionState === "disconnected" && entry.state === "open") {
        setState(entry, "unstable");
      } else if (pc.connectionState === "failed") {
        entry.state = "failed";
        closePeer(
          entry.key,
          `Connection with ${entry.label} failed. Put both devices on the same Wi-Fi or phone hotspot and pair again.`
        );
      }
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      if (!entry.closing) log(`ICE with ${entry.label}: ${pc.iceConnectionState}`);
    });
    pc.addEventListener("icegatheringstatechange", () => {
      if (!entry.closing) log(`ICE gathering (${entry.label}): ${pc.iceGatheringState}`);
    });
  }, [closePeer, log, setState]);

  /* ---------- pairing ---------- */

  function cancelPending(reason) {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const entry = peersRef.current.get(pending.key);
    if (entry && entry.state !== "open") {
      closePeer(pending.key, reason);
      peersRef.current.delete(pending.key);
      publish();
    }
  }

  async function startOffer() {
    if (busy) return;
    setBusy(true);
    cancelPending("Previous pairing attempt cancelled.");
    setMode("creating");
    log("Creating pairing QR…");

    try {
      const { peer, channel, signal } = await createOffer({ log });
      const entry = {
        key: newKey(),
        label: "New device",
        state: "waiting-answer",
        pc: peer,
        channel: null,
        timer: null,
      };
      peersRef.current.set(entry.key, entry);
      watchPeer(entry);
      attachChannel(entry, channel);
      pendingRef.current = { key: entry.key, role: "offer" };
      publish();

      const code = await encodeSignal("offer", signal, propsRef.current.device);
      log(`Pairing QR ready (${code.length} characters).`);
      setQrData(code);
      setMode("show-offer");
    } catch (error) {
      console.error("OFFER ERROR:", error);
      log(`Could not create pairing QR: ${error.message}`);
      setMode("idle");
    } finally {
      setBusy(false);
    }
  }

  async function processPairing(text) {
    if (busy) return;
    setBusy(true);

    try {
      log("Reading pairing code…");
      const data = await decodeSignal(text);
      const remoteName = data.deviceName || "Other device";

      if (data.type === "offer") {
        log(`Offer received from "${remoteName}". Creating answer…`);
        cancelPending("Cancelled this device's own pairing QR (answering instead).");

        const entry = {
          key: newKey(),
          label: remoteName,
          state: "waiting-scan",
          pc: null,
          channel: null,
          timer: null,
        };

        const { peer, signal } = await acceptOffer(data.signal, {
          log,
          onChannel: (channel) => attachChannel(entry, channel),
        });
        entry.pc = peer;
        peersRef.current.set(entry.key, entry);
        watchPeer(entry);
        pendingRef.current = { key: entry.key, role: "answer" };
        startTimer(
          entry,
          ANSWER_SCAN_TIMEOUT_MS,
          `"${remoteName}" did not scan the answer QR within 3 minutes. Pair again.`
        );
        publish();

        const code = await encodeSignal("answer", signal, propsRef.current.device);
        log(`Answer QR ready (${code.length} characters). Scan it on "${remoteName}".`);
        setQrData(code);
        setMode("show-answer");
      } else {
        const pending = pendingRef.current;
        const entry = pending?.role === "offer" ? peersRef.current.get(pending.key) : null;
        if (!entry) {
          throw new Error("This is an answer QR, but this device has no pairing QR waiting. Tap “Create pairing QR” first.");
        }

        await acceptAnswer(entry.pc, data.signal, { log });
        entry.label = remoteName;
        setState(entry, "connecting");
        startTimer(
          entry,
          CONNECT_TIMEOUT_MS,
          `Could not connect to "${remoteName}" within 30 s. Put both devices on the same Wi-Fi or phone hotspot and pair again.`
        );
        log("Answer received. Connecting…");
        setMode("connecting");
      }
      setScanText("");
    } catch (error) {
      console.error("PAIRING ERROR:", error);
      log(`Pairing failed: ${error?.message || String(error)}`);
      setMode("scan");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- camera ---------- */

  async function stopScanner() {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (mountedRef.current) setScanning(false);
    if (scanner?.isScanning) await scanner.stop().catch(() => {});
  }

  async function onDecoded(decodedText) {
    await stopScanner();
    log("QR scanned.");
    await processPairing(decodedText);
  }

  async function startScanner() {
    if (!window.isSecureContext) {
      log("Camera needs HTTPS. Open the https://…loca.lt link, not http.");
      return;
    }

    try {
      await stopScanner();
      const scanner = newScanner();
      scannerRef.current = scanner;
      setScanning(true);
      await scanner.start({ facingMode: "environment" }, scannerConfig(), onDecoded, () => {});
    } catch (error) {
      setScanning(false);
      scannerRef.current = null;
      log("Camera error: " + (error?.message || error));
    }
  }

  // Fallback: take a photo of the QR with the phone's normal camera.
  async function scanFromPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      await stopScanner();
      const result = await newScanner().scanFile(file, false);
      await onDecoded(result);
    } catch {
      log("Couldn't find a QR code in that photo. Try again closer and steadier.");
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(qrData);
      setCopied(true);
      setTimeout(() => mountedRef.current && setCopied(false), 1500);
    } catch {
      log("Copy failed. Select the text and copy it manually.");
    }
  }

  function sendTest() {
    const text = testMessage.trim().slice(0, 500);
    if (!text) return;
    const sentTo = broadcast(buildMessage("TEST", { message: text }));
    log(sentTo.length ? `Test message sent to ${sentTo.join(", ")}.` : "No open connection to send to.");
    setTestMessage("");
  }

  /* ---------- unmount cleanup ---------- */

  useEffect(() => {
    mountedRef.current = true;
    const peerMap = peersRef.current;
    return () => {
      mountedRef.current = false;
      scannerRef.current?.stop().catch(() => {});
      for (const entry of peerMap.values()) {
        clearTimer(entry);
        entry.closing = true;
        try { entry.channel?.close(); } catch { /* ignore */ }
        try { entry.pc?.close(); } catch { /* ignore */ }
      }
      peerMap.clear();
      pendingRef.current = null;
      propsRef.current.onRegisterSender?.(null);
      propsRef.current.onRegisterVolunteerSender?.(null);
      propsRef.current.onStatusChange?.({ peers: [], openCount: 0 });
    };
  }, []);

  /* ---------- render ---------- */

  const openCount = peers.filter((p) => p.state === "open").length;

  const qrBox = (
    <>
      <div className="qr-frame">
        <QRCodeSVG
          value={qrData}
          size={340}
          level="L"
          marginSize={4}
          bgColor="#ffffff"
          fgColor="#000000"
          style={{ width: "min(340px, 80vw)", height: "auto", display: "block" }}
        />
      </div>
      <details className="fallback">
        <summary>Can't scan? Copy the code instead</summary>
        <textarea
          readOnly
          data-testid="pairing-code"
          value={qrData}
          rows={4}
          onFocus={(event) => event.target.select()}
        />
        <button type="button" className="btn" onClick={copyCode}>{copied ? "Copied" : "Copy code"}</button>
      </details>
    </>
  );

  const scanControls = (
    <div className="scan-box">
      <div id={READER_ID} className="reader" />
      <div className="btn-row">
        {!scanning ? (
          <button type="button" className="btn" onClick={startScanner} disabled={busy}>Start camera</button>
        ) : (
          <button type="button" className="btn" onClick={stopScanner}>Stop camera</button>
        )}
        <label className="btn">
          Take a photo of the QR
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={scanFromPhoto}
            hidden
          />
        </label>
      </div>
      <textarea
        data-testid="pairing-input"
        placeholder="Or paste pairing code here"
        rows={3}
        value={scanText}
        onChange={(event) => setScanText(event.target.value)}
      />
      <div className="btn-row">
        <button type="button" className="btn primary" onClick={() => processPairing(scanText)} disabled={busy || !scanText.trim()}>
          Process pairing code
        </button>
        <button type="button" className="btn ghost" onClick={() => { stopScanner(); setMode("idle"); }}>Back</button>
      </div>
      <p className="hint">
        Turn the screen brightness up, hold the phone 15–25 cm away and keep
        the whole QR inside the box.
      </p>
    </div>
  );

  return (
    <section className="block network" data-testid="network-panel">
      <div className="block-head">
        <h2>Device links</h2>
        <label className="device-name">
          This device
          <input
            aria-label="This device's name"
            value={device?.name || ""}
            maxLength={40}
            onChange={(event) => onDeviceNameChange?.(event.target.value)}
          />
        </label>
      </div>

      <p className="net-status" data-testid="network-status">
        <span className={`dot ${openCount > 0 ? "on" : "off"}`} />
        {openCount > 0
          ? `Connected directly to ${openCount} device${openCount === 1 ? "" : "s"}. Other devices are reached only through these links.`
          : "Not connected. Requests are saved here and shared as soon as you pair a device."}
      </p>

      {peers.length > 0 && (
        <ul className="peer-list">
          {peers.map((peer) => (
            <li key={peer.key} data-testid="peer-row" data-state={peer.state}>
              <span className={`dot ${peer.state === "open" ? "on" : peer.state === "failed" || peer.state === "closed" ? "off" : "wait"}`} />
              <strong>{peer.label}</strong>
              <span className="peer-state">{STATE_TEXT[peer.state] || peer.state}</span>
              {peer.state === "open" || peer.state === "unstable" ? (
                <button type="button" className="btn small" onClick={() => closePeer(peer.key, `Disconnected from ${peer.label}.`)}>
                  Disconnect
                </button>
              ) : (
                <button type="button" className="btn small" onClick={() => removePeer(peer.key)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {(mode === "idle" || mode === "connecting") && (
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={startOffer} disabled={busy}>
            {openCount > 0 ? "Pair another device (create QR)" : "Create pairing QR"}
          </button>
          <button type="button" className="btn" onClick={() => setMode("scan")} disabled={busy}>Scan pairing QR</button>
          {mode === "connecting" && <span className="hint">Connecting…</span>}
        </div>
      )}

      {mode === "creating" && <p className="hint">Creating connection… (gathering network info, up to 12 s)</p>}

      {mode === "show-offer" && (
        <div className="pair-step">
          <h3>1. Scan this QR on the other device</h3>
          {qrBox}
          <h3>2. Then scan the answer QR it shows</h3>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={() => setMode("scan-answer")}>Scan answer QR</button>
            <button type="button" className="btn ghost" onClick={() => { cancelPending("Pairing cancelled."); setMode("idle"); }}>Cancel</button>
          </div>
        </div>
      )}

      {(mode === "scan" || mode === "scan-answer") && scanControls}

      {mode === "show-answer" && (
        <div className="pair-step">
          <h3>Scan this answer on the first device</h3>
          {qrBox}
          <p className="hint">Waiting for the first device to scan it…</p>
          <button type="button" className="btn ghost" onClick={() => { cancelPending("Pairing cancelled."); setMode("idle"); }}>Cancel</button>
        </div>
      )}

      {openCount > 0 && (
        <div className="test-row">
          <input
            value={testMessage}
            maxLength={500}
            onChange={(event) => setTestMessage(event.target.value)}
            placeholder="Send a test message to paired devices"
          />
          <button type="button" className="btn" onClick={sendTest}>Send test</button>
        </div>
      )}

      <details className="activity" open={logs.length > 0}>
        <summary>Link activity ({logs.length})</summary>
        <div data-testid="network-log" className="log">
          {logs.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      </details>
    </section>
  );
}
