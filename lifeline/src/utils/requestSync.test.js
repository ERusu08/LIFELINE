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
  withAssignment,
  validateVolunteer,
  upsertVolunteer,
  mergeVolunteerLists,
  matchVolunteers,
  suggestRequests,
  uncoveredRequests,
  toWireVolunteer,
  volunteerIdForDevice,
  volunteerLoad,
  remainingCapacity,
  fitsCapacity,
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

const VNOW = Date.parse("2026-11-14T12:00:00.000Z");
function vol(overrides = {}) {
  return {
    id: "VOL-dev1",
    name: "Sam",
    skills: ["Water supplies", "Transport"],
    area: "Camden",
    available: true,
    createdAt: "2026-11-14T11:00:00.000Z",
    updatedAt: "2026-11-14T11:00:00.000Z",
    ...overrides,
  };
}

test("validateVolunteer keeps whitelisted fields and rejects bad input", () => {
  const ok = validateVolunteer({ ...vol(), skills: ["Water supplies", "Bogus", "Water supplies"], evil: "x" }, VNOW);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.volunteer.skills, ["Water supplies"]);
  assert.equal("evil" in ok.volunteer, false);
  assert.equal(validateVolunteer(vol({ id: "x" }), VNOW).ok, false);
  assert.equal(validateVolunteer(vol({ name: "  " }), VNOW).ok, false);
  assert.equal(validateVolunteer(vol({ skills: ["Other", "Bogus"] }), VNOW).ok, false);
  assert.equal(validateVolunteer(vol({ createdAt: "2030-01-01T00:00:00Z" }), VNOW).ok, false);
  assert.equal(validateVolunteer(vol({ available: false }), VNOW).volunteer.available, false);
  assert.equal(volunteerIdForDevice("ab12 !x"), "VOL-ab12x");
  assert.equal(validateVolunteer(toWireVolunteer(vol()), VNOW).ok, true);
});

test("upsert/merge volunteers: one entry per ID, newest wins", () => {
  const older = vol();
  const newer = vol({ available: false, updatedAt: "2026-11-14T11:30:00.000Z" });
  let list = upsertVolunteer([], older);
  list = upsertVolunteer(list, newer);
  assert.equal(list.length, 1);
  assert.equal(list[0].available, false);
  assert.equal(upsertVolunteer(list, older)[0].available, false);
  assert.equal(mergeVolunteerLists([older], [newer, vol({ id: "VOL-dev2", name: "Ana" })]).length, 2);
});

test("matching: only available volunteers with the right skill; urgent+oldest first", () => {
  const water = validateRequest(sample({ id: "SOS-w", category: "Water supplies" }), NOW).request;
  const medical = validateRequest(sample({ id: "SOS-m", category: "Medical assistance" }), NOW).request;
  const other = validateRequest(sample({ id: "SOS-o", category: "Other" }), NOW).request;
  const sam = vol();
  const busy = vol({ id: "VOL-dev2", name: "Busy", available: false });
  const nurse = vol({ id: "VOL-dev3", name: "Nia", skills: ["Medical assistance"] });
  const all = [sam, busy, nurse];

  assert.deepEqual(matchVolunteers(water, all).map((v) => v.name), ["Sam"]);
  assert.deepEqual(matchVolunteers(medical, all).map((v) => v.name), ["Nia"]);
  assert.deepEqual(matchVolunteers(other, all).map((v) => v.name).sort(), ["Nia", "Sam"]);
  assert.deepEqual(matchVolunteers({ ...water, status: "Assigned" }, all), []);
  assert.deepEqual(uncoveredRequests([water, medical], [sam]).map((r) => r.id), ["SOS-m"]);

  const low = validateRequest(sample({ id: "SOS-l", category: "Transport", urgency: "Low", createdAt: "2026-11-14T08:00:00.000Z" }), NOW).request;
  const crit = validateRequest(sample({ id: "SOS-c", category: "Water supplies", urgency: "Critical", createdAt: "2026-11-14T10:00:00.000Z" }), NOW).request;
  assert.deepEqual(suggestRequests(sam, [low, crit, medical]).map((r) => r.id), ["SOS-c", "SOS-l"]);
  assert.deepEqual(suggestRequests(busy, [low, crit]), []);
});

test("withAssignment assigns, survives the wire, and reopening releases the volunteer", () => {
  const original = validateRequest(sample(), NOW).request;
  const assigned = withAssignment(original, vol(), NOW);
  assert.equal(assigned.status, "Assigned");
  assert.equal(assigned.assignedTo, "Sam");
  assert.equal(decideMerge(original, assigned), "update");

  const wire = JSON.parse(JSON.stringify(toWireRequest(assigned)));
  const received = validateRequest(wire, NOW).request;
  assert.equal(received.assignedTo, "Sam");
  assert.equal(received.assignedId, "VOL-dev1");

  const reopened = withStatus(assigned, "Open", NOW + 60000);
  assert.equal("assignedTo" in reopened, false);
  assert.equal(validateRequest({ ...toWireRequest(assigned), status: "Open" }, NOW).request.assignedTo, undefined);
  assert.equal(withAssignment(original, null, NOW), original);
});

test("parseMessage accepts VOLUNTEER and rejects malformed ones", () => {
  const text = buildMessage("VOLUNTEER", { volunteer: toWireVolunteer(vol()), hops: 2 });
  const parsed = parseMessage(text);
  assert.equal(parsed.type, "VOLUNTEER");
  assert.equal(parsed.hops, 2);
  assert.throws(() => parseMessage(JSON.stringify({ type: "VOLUNTEER" })), /no volunteer/);
});

test("capacity: load counts people on Assigned requests, limits matching, survives the wire", () => {
  const sam = vol({ capacity: 5 });
  const req = (id, people, status, extra = {}) =>
    validateRequest(sample({ id, people, status, category: "Water supplies", ...extra }), NOW).request;

  const a = { ...req("SOS-a", 3, "Assigned"), assignedId: "VOL-dev1", assignedTo: "Sam" };
  const resolved = { ...req("SOS-r", 4, "Resolved"), assignedId: "VOL-dev1" };
  const other = { ...req("SOS-o", 4, "Assigned"), assignedId: "VOL-someone-else" };
  const all = [a, resolved, other];

  assert.equal(volunteerLoad(sam, all), 3, "only this volunteer's Assigned requests count");
  assert.equal(remainingCapacity(sam, all), 2);
  assert.equal(remainingCapacity(vol(), all), Infinity, "no limit set means unlimited");

  const small = req("SOS-s", 2, "Open");
  const big = req("SOS-b", 3, "Open");
  assert.equal(fitsCapacity(sam, small, all), true);
  assert.equal(fitsCapacity(sam, big, all), false);

  // can't fit the big one, but is still listed (flagged) while room remains; full volunteers vanish
  assert.deepEqual(matchVolunteers(big, [sam], all).map((v) => v.id), ["VOL-dev1"]);
  const full = [{ ...a, people: 5 }];
  assert.deepEqual(matchVolunteers(small, [sam], full), []);
  assert.equal(uncoveredRequests([small, { ...small, id: "SOS-s2" }], [sam]).length, 0);

  // fitting volunteers are listed before ones that do not fit
  const roomy = vol({ id: "VOL-dev9", name: "Zed", capacity: 20 });
  assert.deepEqual(matchVolunteers(big, [sam, roomy], all).map((v) => v.name), ["Zed", "Sam"]);

  // capacity is validated, clamped and kept on the wire; older profiles have none
  assert.equal(validateVolunteer(vol({ capacity: 5000 }), VNOW).volunteer.capacity, 1000);
  assert.equal(validateVolunteer(vol({ capacity: 0 }), VNOW).volunteer.capacity, 1);
  assert.equal("capacity" in validateVolunteer(vol({ capacity: "lots" }), VNOW).volunteer, false);
  assert.equal(validateVolunteer(toWireVolunteer(sam), VNOW).volunteer.capacity, 5);
  assert.equal("capacity" in toWireVolunteer(vol()), false);
});
