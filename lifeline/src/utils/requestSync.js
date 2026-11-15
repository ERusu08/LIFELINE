// Pure helpers for validating, merging and transporting emergency requests.
// No React / browser APIs here, so this file is unit-tested with `npm test`.

export const MAX_MESSAGE_CHARS = 16 * 1024; // hard limit for one data-channel message
export const MAX_HOPS = 6; // how many devices a request may be relayed through
export const MAX_SYNC_REQUESTS = 50; // requests shared with a newly connected peer

export const CATEGORIES = [
  "Medical assistance",
  "Water supplies",
  "Food supplies",
  "Shelter",
  "Transport",
  "Other",
];
export const URGENCIES = ["Critical", "High", "Medium", "Low"];
export const STATUSES = ["Open", "Assigned", "Resolved"];

// The four built-in demo requests. They exist on every device already, so
// they are never sent over the network.
export const DEMO_IDS = new Set(["SOS-101", "SOS-102", "SOS-103", "SOS-104"]);

const ID_PATTERN = /^SOS-[A-Za-z0-9-]{1,48}$/;
const MESSAGE_TYPES = new Set(["HELLO", "SOS_REQUEST", "SOS_ACK", "TEST"]);

export function makeRequestId(now = Date.now(), random = Math.random) {
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `SOS-${now.toString(36)}-${suffix}`;
}

export function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function toTimestamp(value) {
  if (typeof value !== "string") return NaN;
  return Date.parse(value);
}

export function requestTimestamp(request) {
  const updated = toTimestamp(request?.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = toTimestamp(request?.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/**
 * Validates an emergency request that arrived from another device.
 * Returns { ok: true, request } with ONLY whitelisted, cleaned fields,
 * or { ok: false, error }.
 */
export function validateRequest(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Request is not an object." };
  }

  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
    return { ok: false, error: "Request has an invalid ID." };
  }

  const name = cleanText(raw.name, 80);
  if (!name) return { ok: false, error: "Request is missing a name." };

  const location = cleanText(raw.location, 120);
  if (!location) return { ok: false, error: "Request is missing a location." };

  if (!URGENCIES.includes(raw.urgency)) {
    return { ok: false, error: "Request has an invalid urgency." };
  }

  const createdAt = toTimestamp(raw.createdAt);
  if (!Number.isFinite(createdAt)) {
    return { ok: false, error: "Request has an invalid creation time." };
  }
  if (createdAt > now + 24 * 60 * 60 * 1000) {
    return { ok: false, error: "Request creation time is in the future." };
  }

  let updatedAt = toTimestamp(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt < createdAt) updatedAt = createdAt;
  if (updatedAt > now + 24 * 60 * 60 * 1000) updatedAt = createdAt;

  const request = {
    id: raw.id,
    name,
    category: CATEGORIES.includes(raw.category) ? raw.category : "Other",
    location,
    people: Number.isInteger(raw.people)
      ? Math.min(Math.max(raw.people, 1), 10000)
      : 1,
    urgency: raw.urgency,
    status: STATUSES.includes(raw.status) ? raw.status : "Open",
    description: cleanText(raw.description, 1000),
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    originName: cleanText(raw.originName, 40),
  };

  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (
    raw.lat !== undefined &&
    raw.lng !== undefined &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  ) {
    request.lat = lat;
    request.lng = lng;
  }

  return { ok: true, request };
}

/**
 * Decides what to do with an incoming request given what is already stored.
 * "new"       – not seen before, store it
 * "update"    – newer version of a stored request, replace it
 * "duplicate" – same or older version, ignore it
 */
export function decideMerge(existing, incoming) {
  if (!existing) return "new";
  return requestTimestamp(incoming) > requestTimestamp(existing)
    ? "update"
    : "duplicate";
}

/**
 * Returns a copy of `request` with a new status and a fresh `updatedAt`.
 * `updatedAt` is always strictly newer than the previous version so the
 * change wins when devices merge, even if clocks differ by a few seconds.
 * Returns the same object if the status is invalid or unchanged.
 */
export function withStatus(request, status, now = Date.now()) {
  if (!STATUSES.includes(status) || request.status === status) return request;
  const updatedAt = Math.max(now, requestTimestamp(request) + 1);
  return { ...request, status, updatedAt: new Date(updatedAt).toISOString() };
}

/** Inserts or replaces a request in a list, never replacing with an older copy. */
export function upsertRequest(list, request) {
  const index = list.findIndex((item) => item.id === request.id);
  if (index === -1) return sortRequests([request, ...list]);
  // Never replace a stored request with an older copy of it.
  if (requestTimestamp(request) < requestTimestamp(list[index])) return list;
  const next = list.slice();
  next[index] = request;
  return sortRequests(next);
}

/** Merges two lists by ID, keeping the newest version of each request. */
export function mergeRequestLists(a, b) {
  return b.reduce((list, request) => upsertRequest(list, request), sortRequests(a));
}

export function sortRequests(list) {
  return list.slice().sort((x, y) => {
    const tx = toTimestamp(x.createdAt);
    const ty = toTimestamp(y.createdAt);
    const vx = Number.isFinite(tx) ? tx : -Infinity;
    const vy = Number.isFinite(ty) ? ty : -Infinity;
    if (vx !== vy) return vy - vx; // newest first; demo items (no date) last
    return String(y.id).localeCompare(String(x.id));
  });
}

export function isShareable(request) {
  return Boolean(
    request &&
      !DEMO_IDS.has(request.id) &&
      request.source !== "demo" &&
      Number.isFinite(toTimestamp(request.createdAt))
  );
}

/** Strips local-only fields before a request leaves this device. */
export function toWireRequest(request) {
  const {
    id, name, category, location, people, urgency, status,
    description, createdAt, updatedAt, lat, lng, originName,
  } = request;
  const wire = {
    id, name, category, location, people, urgency, status,
    description, createdAt, updatedAt, originName,
  };
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    wire.lat = lat;
    wire.lng = lng;
  }
  return wire;
}

export function buildMessage(type, fields = {}) {
  const text = JSON.stringify({ type, ...fields });
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new Error(`Message too large (${text.length} characters).`);
  }
  return text;
}

/** Parses one data-channel message. Throws a readable Error if invalid. */
export function parseMessage(raw) {
  if (typeof raw !== "string") throw new Error("Binary messages are not supported.");
  if (raw.length > MAX_MESSAGE_CHARS) throw new Error("Message too large.");

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Message is not valid JSON.");
  }

  if (!data || typeof data !== "object" || !MESSAGE_TYPES.has(data.type)) {
    throw new Error("Unknown message type.");
  }

  if (data.type === "SOS_REQUEST") {
    if (!data.request || typeof data.request !== "object") {
      throw new Error("SOS_REQUEST has no request.");
    }
    const hops = Number.isInteger(data.hops) ? data.hops : 0;
    return { type: data.type, request: data.request, hops: Math.max(0, hops) };
  }

  if (data.type === "SOS_ACK") {
    if (typeof data.id !== "string" || !ID_PATTERN.test(data.id)) {
      throw new Error("SOS_ACK has an invalid ID.");
    }
    return { type: data.type, id: data.id };
  }

  if (data.type === "HELLO") {
    return {
      type: data.type,
      deviceId: cleanText(data.deviceId, 40),
      name: cleanText(data.name, 40),
    };
  }

  return { type: data.type, message: cleanText(data.message, 500) };
}

export function formatRelativeTime(request, now = Date.now()) {
  const created = toTimestamp(request?.createdAt);
  if (!Number.isFinite(created)) return request?.time || "";
  const seconds = Math.max(0, Math.round((now - created) / 1000));
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(created).toLocaleDateString();
}
