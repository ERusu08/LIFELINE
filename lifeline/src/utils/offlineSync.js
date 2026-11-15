// Moves LIFELINE data between devices with NO network at all.
//
//   - a looping series of QR codes shown on one screen and scanned by another
//   - a file sent with AirDrop / Nearby Share / Bluetooth and imported
//   - a copied text code
//
// All three carry the same "sync code". It is only a carrier: every request
// and volunteer inside is validated and merged by the normal rules on the
// receiving device (whitelisted fields, newest change wins, no duplicates).

import { cleanText, toWireRequest, toWireVolunteer } from "./requestSync.js";
import { toBase64Url, fromBase64Url, canCompress, deflate, inflate } from "./codec.js";

export const FRAME_CHARS = 400; // payload characters per QR frame (keeps each QR easy to scan)
export const MAX_CODE_CHARS = 200 * 1024;
export const MAX_ITEMS = 200;

const FRAME_PREFIX = "LF1";
const FRAME_PATTERN = /^LF1\.([a-z0-9]{6})\.(\d{1,4})\.(\d{1,4})\.([A-Za-z0-9_~-]+)$/;

export function buildSyncData({ requests = [], volunteers = [], deviceName = "" }) {
  return {
    k: "lifeline-sync",
    v: 1,
    n: cleanText(deviceName, 40),
    t: new Date().toISOString(),
    r: requests.slice(0, MAX_ITEMS).map(toWireRequest),
    u: volunteers.slice(0, MAX_ITEMS).map(toWireVolunteer),
  };
}

/** data -> "LS1:<compressed>" (or "LS0:<plain>" if the browser cannot compress). */
export async function encodeSyncCode(data) {
  const json = JSON.stringify(data);
  if (canCompress()) return "LS1:" + toBase64Url(await deflate(json));
  return "LS0:" + toBase64Url(new TextEncoder().encode(json));
}

/** "LS1:..." -> { deviceName, requests, volunteers }. Throws a readable Error. */
export async function decodeSyncCode(code) {
  const text = String(code || "").trim();
  if (!text) throw new Error("The sync code is empty.");
  if (text.length > MAX_CODE_CHARS) throw new Error("The sync code is too large.");

  let json;
  try {
    if (text.startsWith("LS1:")) {
      if (!canCompress()) throw new Error("This browser cannot read compressed sync codes.");
      json = await inflate(fromBase64Url(text.slice(4)));
    } else if (text.startsWith("LS0:")) {
      json = new TextDecoder().decode(fromBase64Url(text.slice(4)));
    } else {
      throw new Error("This is not a LIFELINE sync code.");
    }
  } catch (error) {
    if (/not a LIFELINE|cannot read/.test(error.message)) throw error;
    throw new Error("The sync code is damaged or incomplete.", { cause: error });
  }

  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("The sync code is damaged or incomplete.");
  }
  if (!data || data.k !== "lifeline-sync" || data.v !== 1) {
    throw new Error("This is not a LIFELINE sync code (or it is from a newer version).");
  }
  return {
    deviceName: cleanText(data.n, 40),
    requests: Array.isArray(data.r) ? data.r.slice(0, MAX_ITEMS) : [],
    volunteers: Array.isArray(data.u) ? data.u.slice(0, MAX_ITEMS) : [],
  };
}

function checksum(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(-6);
}

/** Splits a sync code into QR-sized frames: "LF1.<id>.<index>.<total>.<data>". */
export function makeFrames(code, size = FRAME_CHARS) {
  const id = checksum(code);
  const total = Math.max(1, Math.ceil(code.length / size));
  const frames = [];
  for (let i = 0; i < total; i++) {
    frames.push(`${FRAME_PREFIX}.${id}.${i}.${total}.${code.slice(i * size, (i + 1) * size).replace(/:/g, "~")}`);
  }
  return frames;
}

export function isFrame(text) {
  return FRAME_PATTERN.test(String(text || "").trim());
}

/**
 * Collects scanned frames in ANY order, ignoring repeats. Frames of a different
 * sync code restart the collection, so a stale half-scan can never be mixed in.
 */
export class FrameCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.id = null;
    this.total = 0;
    this.parts = new Map();
  }

  get progress() {
    return { have: this.parts.size, total: this.total };
  }

  /** Returns "ignored" | "added" | "duplicate" | "complete". */
  add(text) {
    const match = FRAME_PATTERN.exec(String(text || "").trim());
    if (!match) return "ignored";
    const [, id, indexText, totalText, data] = match;
    const index = Number(indexText);
    const total = Number(totalText);
    if (total < 1 || index >= total) return "ignored";

    if (this.id !== id || this.total !== total) {
      this.reset();
      this.id = id;
      this.total = total;
    }
    if (this.parts.has(index)) return "duplicate";
    this.parts.set(index, data);
    return this.parts.size === this.total ? "complete" : "added";
  }

  /** The reassembled sync code; throws if frames are missing or corrupted. */
  code() {
    if (!this.id || this.parts.size !== this.total) throw new Error("Some QR frames are still missing.");
    let text = "";
    for (let i = 0; i < this.total; i++) text += this.parts.get(i);
    text = text.replace(/~/g, ":");
    if (checksum(text) !== this.id) throw new Error("The scanned frames do not match. Scan again from the start.");
    return text;
  }
}

/** Accepts a full sync code, or pasted frame lines (one per line / space separated). */
export async function readSyncInput(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("Nothing to import.");
  const pieces = text.split(/\s+/).filter(Boolean);
  if (pieces.every(isFrame)) {
    const collector = new FrameCollector();
    for (const piece of pieces) collector.add(piece);
    return decodeSyncCode(collector.code());
  }
  return decodeSyncCode(text);
}
