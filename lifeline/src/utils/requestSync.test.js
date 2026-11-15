import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRequest,
  decideMerge,
  upsertRequest,
  mergeRequestLists,
  parseMessage,
  buildMessage,
  isShareable,
  toWireRequest,
  makeRequestId,
  withStatus,
  MAX_MESSAGE_CHARS,
} from "./requestSync.js";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");

function sample(overrides = {}) {
  return {
    id: "SOS-abc123-x9z1",
    name: "Household Z",
    category: "Medical assistance",
    location: "Camden",
    people: 2,
    urgency: "High",
    status: "Open",
    description: "Needs insulin",
    createdAt: "2026-11-14T11:59:00.000Z",
    updatedAt: "2026-11-14T11:59:00.000Z",
    lat: 51.54,
    lng: -0.14,
    ...overrides,
  };
}

test("valid request passes and keeps only whitelisted fields", () => {
  const result = validateRequest(sample({ evil: "<script>", source: "local" }), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.request.evil, undefined);
  assert.equal(result.request.source, undefined);
  assert.equal(result.request.lat, 51.54);
});

test("rejects bad IDs, missing fields, bad urgency and future dates", () => {
  assert.equal(validateRequest(null).ok, false);
  assert.equal(validateRequest([]).ok, false);
  assert.equal(validateRequest(sample({ id: "../../etc" }), NOW).ok, false);
  assert.equal(validateRequest(sample({ id: "SOS-" + "a".repeat(80) }), NOW).ok, false);
  assert.equal(validateRequest(sample({ name: "   " }), NOW).ok, false);
  assert.equal(validateRequest(sample({ location: undefined }), NOW).ok, false);
  assert.equal(validateRequest(sample({ urgency: "Apocalyptic" }), NOW).ok, false);
  assert.equal(validateRequest(sample({ createdAt: "not a date" }), NOW).ok, false);
  assert.equal(validateRequest(sample({ createdAt: "2030-01-01T00:00:00Z" }), NOW).ok, false);
});

test("cleans and limits text, clamps people, drops invalid coordinates", () => {
  const { request } = validateRequest(
    sample({
      name: "A\u0000B" + "x".repeat(200),
      people: 999999,
      category: "Unknown",
      status: "Weird",
      lat: 500,
    }),
    NOW
  );
  assert.equal(request.name.length, 80);
  assert.ok(!request.name.includes("\u0000"));
  assert.equal(request.people, 10000);
  assert.equal(request.category, "Other");
  assert.equal(request.status, "Open");
  assert.equal(request.lat, undefined);
  assert.equal(request.lng, undefined);
});

test("decideMerge: new, duplicate, older and newer versions", () => {
  const stored = sample();
  assert.equal(decideMerge(undefined, stored), "new");
  assert.equal(decideMerge(stored, sample()), "duplicate");
  assert.equal(decideMerge(stored, sample({ updatedAt: "2026-11-14T11:00:00.000Z" })), "duplicate");
  assert.equal(decideMerge(stored, sample({ updatedAt: "2026-11-14T11:59:30.000Z" })), "update");
});

test("upsertRequest never duplicates and never replaces with an older copy", () => {
  const newer = sample({ updatedAt: "2026-11-14T11:59:50.000Z", status: "Assigned" });
  let list = upsertRequest([], newer);
  list = upsertRequest(list, sample()); // older copy arrives late
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "Assigned");
});

test("mergeRequestLists keeps requests that arrived before the DB finished loading", () => {
  const fromDb = [sample({ id: "SOS-old-0001", createdAt: "2026-11-14T10:00:00.000Z" })];
  const arrivedEarly = [sample({ id: "SOS-net-0002" })];
  const merged = mergeRequestLists(fromDb, arrivedEarly);
  assert.deepEqual(merged.map((r) => r.id).sort(), ["SOS-net-0002", "SOS-old-0001"]);
  assert.equal(merged[0].id, "SOS-net-0002"); // newest first
});

test("parseMessage validates type, size and payload", () => {
  assert.throws(() => parseMessage("not json"), /valid JSON/);
  assert.throws(() => parseMessage(JSON.stringify({ type: "DROP_TABLES" })), /Unknown message type/);
  assert.throws(() => parseMessage("x".repeat(MAX_MESSAGE_CHARS + 1)), /too large/);
  assert.throws(() => parseMessage(JSON.stringify({ type: "SOS_ACK", id: "bad id" })), /invalid ID/);
  assert.throws(() => parseMessage(JSON.stringify({ type: "SOS_REQUEST" })), /no request/);

  const sos = parseMessage(buildMessage("SOS_REQUEST", { request: sample(), hops: 2 }));
  assert.equal(sos.hops, 2);
  assert.equal(sos.request.id, "SOS-abc123-x9z1");
  assert.equal(parseMessage(buildMessage("SOS_ACK", { id: "SOS-abc123-x9z1" })).id, "SOS-abc123-x9z1");
});

test("buildMessage refuses oversized messages", () => {
  assert.throws(() => buildMessage("TEST", { message: "x".repeat(MAX_MESSAGE_CHARS) }), /too large/);
});

test("demo requests are never shared; local-only fields are stripped", () => {
  assert.equal(isShareable({ id: "SOS-104", createdAt: "2026-11-14T11:00:00Z" }), false);
  assert.equal(isShareable({ id: "SOS-x-1", source: "demo", createdAt: "2026-11-14T11:00:00Z" }), false);
  assert.equal(isShareable(sample({ source: "local" })), true);
  const wire = toWireRequest(sample({ source: "local", receivedFrom: "Phone A" }));
  assert.equal(wire.source, undefined);
  assert.equal(wire.receivedFrom, undefined);
});

test("generated IDs are valid and unique", () => {
  const ids = new Set(Array.from({ length: 500 }, () => makeRequestId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.equal(validateRequest(sample({ id }), NOW).ok, true);
});

test("withStatus bumps updatedAt so the change wins a merge, and ignores invalid/no-op changes", () => {
  const original = validateRequest(sample(), NOW).request;
  const changed = withStatus(original, "Assigned", NOW);
  assert.equal(changed.status, "Assigned");
  assert.ok(requestNewer(changed, original));
  assert.equal(decideMerge(original, changed), "update");
  assert.equal(decideMerge(changed, original), "duplicate");

  // Clock behind the stored copy: still strictly newer.
  const skewed = withStatus(original, "Resolved", NOW - 10 * 60 * 1000);
  assert.ok(requestNewer(skewed, original));

  assert.equal(withStatus(original, "Open", NOW), original);
  assert.equal(withStatus(original, "Bogus", NOW), original);

  // The status change survives the wire round trip.
  const wire = JSON.parse(JSON.stringify(toWireRequest(changed)));
  assert.equal(validateRequest(wire, NOW).request.status, "Assigned");
});

function requestNewer(a, b) {
  return Date.parse(a.updatedAt) > Date.parse(b.updatedAt);
}
