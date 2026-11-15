// WebRTC helpers for LIFELINE's QR pairing.
//
// Pairing uses "non-trickle" ICE: each side gathers its network candidates
// first and puts them inside the QR code, because QR codes are the only
// signalling channel we have. Every async step has a timeout and is logged.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const STEP_TIMEOUT_MS = 10000;

const noop = () => {};

export function createPeerConnection() {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("This browser does not support WebRTC.");
  }
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function step(log, label, fn, ms = STEP_TIMEOUT_MS) {
  const started = performance.now();
  log(`${label}...`);
  try {
    const result = await withTimeout(Promise.resolve().then(fn), ms, label);
    log(`${label} done (${Math.round(performance.now() - started)} ms).`);
    return result;
  } catch (error) {
    const message = error?.message || String(error);
    log(`${label} FAILED: ${message}`);
    throw new Error(`${label} failed: ${message}`, { cause: error });
  }
}

function candidateType(candidate) {
  if (candidate.type) return candidate.type;
  const match = / typ (\w+)/.exec(candidate.candidate || "");
  return match ? match[1] : "host";
}

/**
 * Watches ICE gathering. Must be started BEFORE setLocalDescription so that
 * no candidates are missed. Resolves when there is enough connection
 * information, rejects if NO candidate at all was gathered.
 *
 *  - gathering "complete"                      -> done
 *  - a public (srflx) candidate + 1.5 s         -> done (enough for LAN + internet)
 *  - only local (host) candidates after 5 s    -> done (works on the same Wi-Fi)
 *  - 12 s hard limit                           -> done if anything was found
 *  - nothing gathered at all                   -> error (never return an unusable SDP)
 */
function watchIceGathering(peer, log) {
  let cancel = noop;

  const promise = new Promise((resolve, reject) => {
    const started = Date.now();
    const counts = { host: 0, srflx: 0, relay: 0, prflx: 0 };
    let finished = false;

    const onCandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate) return;
      const type = candidateType(event.candidate);
      counts[type] = (counts[type] || 0) + 1;
    };

    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      peer.removeEventListener("icecandidate", onCandidate);
      peer.removeEventListener("icegatheringstatechange", onState);

      const total = counts.host + counts.srflx + counts.relay + counts.prflx;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (reason === "cancelled") {
        reject(new Error("ICE gathering cancelled."));
        return;
      }
      if (total === 0) {
        reject(new Error(
          `No network candidates found after ${seconds}s. ` +
          "Check the device is on Wi-Fi (not airplane mode) and try again."
        ));
        return;
      }
      log(
        `Network info ready (${reason}, ${seconds}s): ` +
        `${counts.host} local, ${counts.srflx} public candidate(s).`
      );
      resolve(counts);
    };

    const onState = () => {
      if (peer.iceGatheringState === "complete") finish("complete");
    };

    peer.addEventListener("icecandidate", onCandidate);
    peer.addEventListener("icegatheringstatechange", onState);

    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      if (counts.srflx > 0 && elapsed >= 1500) finish("public address found");
      else if (counts.host + counts.srflx > 0 && elapsed >= 5000) finish("local addresses only");
      else if (elapsed >= 12000) finish("time limit");
    }, 250);

    cancel = () => finish("cancelled");
  });

  promise.catch(noop); // the caller awaits it; avoid "unhandled rejection" noise
  return { promise, cancel: () => cancel() };
}

function assertUsableSdp(description, label) {
  const sdp = description?.sdp || "";
  const missing = ["a=ice-ufrag", "a=ice-pwd", "a=fingerprint", "m=application"].filter(
    (line) => !sdp.includes(line)
  );
  if (missing.length) {
    throw new Error(`${label} is incomplete (missing ${missing.join(", ")}).`);
  }
  if (!sdp.includes("a=candidate")) {
    throw new Error(`${label} contains no network candidates.`);
  }
}

/* ---------- QR payload shrinking ----------
 * A raw SDP is 600-1500+ characters, which makes a QR code too dense for a
 * phone to read off a laptop screen. We drop lines a data channel doesn't
 * need, keep only the most useful candidates, then deflate + base64.
 */

function candidateRank(line) {
  const parts = line.split(" ");
  const protocol = (parts[2] || "").toLowerCase();
  const address = parts[4] || "";
  const type = / typ (\w+)/.exec(line)?.[1] || "host";
  const ipv6 = address.includes(":");
  return { protocol, address, type, ipv6 };
}

export function slimSdp(sdp) {
  const lines = sdp.split(/\r?\n/).filter(Boolean);

  // Choose which candidates to keep: UDP only, de-duplicated, IPv4 first,
  // at most 2 local + 2 public, plus IPv6 only if there is little IPv4.
  const candidates = lines
    .filter((line) => line.startsWith("a=candidate"))
    .map((line) => ({ line, ...candidateRank(line) }))
    .filter((c) => c.protocol === "udp");

  const keep = new Set();
  const seen = new Set();
  const pick = (filter, limit) => {
    let added = 0;
    for (const c of candidates) {
      if (added >= limit) break;
      if (!filter(c) || seen.has(c.address)) continue;
      seen.add(c.address);
      keep.add(c.line);
      added++;
    }
  };
  pick((c) => c.type === "host" && !c.ipv6, 2);
  pick((c) => c.type === "srflx" && !c.ipv6, 2);
  pick((c) => c.type === "relay", 1);
  if (keep.size < 2) pick((c) => c.ipv6, 2);

  return lines
    .filter((line) => {
      if (line.startsWith("a=candidate")) return keep.has(line);
      if (line.startsWith("a=end-of-candidates")) return false;
      if (line.startsWith("a=extmap-allow-mixed")) return false;
      if (line.startsWith("a=msid-semantic")) return false;
      return true;
    })
    .join("\r\n") + "\r\n";
}

function toBase64Url(bytes) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function canCompress() {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined"
  );
}

async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

/**
 * type: "offer" | "answer", description: RTCSessionDescription,
 * device: { id, name } of THIS device (shown to the other side).
 */
export async function encodeSignal(type, description, device = {}) {
  const payload = JSON.stringify({
    t: type,
    s: slimSdp(description.sdp),
    d: String(device.id || "").slice(0, 40),
    n: String(device.name || "").slice(0, 40),
  });

  if (!canCompress()) return payload;

  try {
    const bytes = await withTimeout(deflate(payload), 5000, "Compressing pairing code");
    return "L1:" + toBase64Url(bytes);
  } catch {
    return payload; // fall back to the uncompressed form
  }
}

// Returns { type: "offer" | "answer", signal: { type, sdp }, deviceId, deviceName }
export async function decodeSignal(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Pairing code is empty.");
  if (trimmed.length > 8000) throw new Error("Pairing code is too long.");

  let data;
  if (trimmed.startsWith("L1:")) {
    if (!canCompress()) {
      throw new Error("This browser can't read compressed pairing codes. Update it and try again.");
    }
    let json;
    try {
      json = await withTimeout(inflate(fromBase64Url(trimmed.slice(3))), 5000, "Reading pairing code");
    } catch (error) {
      throw new Error("Pairing code is damaged or incomplete: " + error.message, { cause: error });
    }
    data = JSON.parse(json);
  } else {
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error("This is not a LIFELINE pairing code.");
    }
  }

  // Compact format produced by encodeSignal
  if ((data.t === "offer" || data.t === "answer") && typeof data.s === "string") {
    return {
      type: data.t,
      signal: { type: data.t, sdp: data.s },
      deviceId: typeof data.d === "string" ? data.d : "",
      deviceName: typeof data.n === "string" ? data.n : "",
    };
  }

  // Older uncompressed format: { type, signal: RTCSessionDescription }
  if ((data.type === "offer" || data.type === "answer") && data.signal?.sdp) {
    return { type: data.type, signal: data.signal, deviceId: "", deviceName: "" };
  }

  throw new Error("Invalid pairing code.");
}

/* ---------- Pairing steps ---------- */

export async function createOffer({ log = noop } = {}) {
  const peer = createPeerConnection();
  const ice = watchIceGathering(peer, log);

  try {
    const channel = peer.createDataChannel("lifeline", { ordered: true });
    const offer = await step(log, "Creating offer", () => peer.createOffer());
    await step(log, "Setting local description (offer)", () => peer.setLocalDescription(offer));
    await step(log, "Gathering network info", () => ice.promise, 15000);
    assertUsableSdp(peer.localDescription, "Offer");
    return { peer, channel, signal: peer.localDescription };
  } catch (error) {
    ice.cancel();
    peer.close();
    throw error;
  }
}

// onChannel(channel) is called LATER, when the first device has scanned our
// answer and the connection opens. It is never awaited here: the channel can
// only open after the answer QR has been shown and scanned.
export async function acceptOffer(offer, { log = noop, onChannel = noop } = {}) {
  const peer = createPeerConnection();
  peer.addEventListener("datachannel", (event) => onChannel(event.channel));
  const ice = watchIceGathering(peer, log);

  try {
    await step(log, "Applying received offer", () => peer.setRemoteDescription(offer));
    const answer = await step(log, "Creating answer", () => peer.createAnswer());
    await step(log, "Setting local description (answer)", () => peer.setLocalDescription(answer));
    await step(log, "Gathering network info", () => ice.promise, 15000);
    assertUsableSdp(peer.localDescription, "Answer");
    return { peer, signal: peer.localDescription };
  } catch (error) {
    ice.cancel();
    peer.close();
    throw error;
  }
}

export async function acceptAnswer(peer, answer, { log = noop } = {}) {
  if (peer.signalingState !== "have-local-offer") {
    throw new Error(
      `This device is not waiting for an answer (state: ${peer.signalingState}). Create a new pairing QR.`
    );
  }
  await step(log, "Applying received answer", () => peer.setRemoteDescription(answer));
}
