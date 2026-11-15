import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSyncData, encodeSyncCode, decodeSyncCode, makeFrames, FrameCollector, readSyncInput, isFrame, FRAME_CHARS,
} from "./offlineSync.js";

function request(i) {
  return {
    id: `SOS-test-${String(i).padStart(4, "0")}`,
    name: `Household ${i}`,
    category: "Water supplies",
    location: "Camden Town, near the canal",
    people: 3,
    urgency: "High",
    status: "Open",
    description: `Need drinking water for the family, request number ${i}, elderly parent and a baby`,
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
    originName: "Alpha",
    lat: 51.54 + i / 10000,
    lng: -0.14,
    source: "local", // local-only field: must not travel
  };
}
const volunteer = { id: "VOL-a1", name: "Sam", skills: ["Transport"], area: "Camden", available: true, createdAt: "2026-11-14T09:00:00.000Z", updatedAt: "2026-11-14T09:00:00.000Z" };

test("round trip: data survives encode, frames (any order, repeats) and decode", async () => {
  const data = buildSyncData({ requests: [request(1), request(2)], volunteers: [volunteer], deviceName: "Alpha" });
  const code = await encodeSyncCode(data);
  const frames = makeFrames(code, 120);
  assert.ok(frames.length > 2);
  assert.ok(frames.every(isFrame));

  const collector = new FrameCollector();
  const shuffled = [...frames].reverse();
  assert.equal(collector.add(shuffled[0]), shuffled.length === 1 ? "complete" : "added");
  assert.equal(collector.add(shuffled[0]), "duplicate");
  let last;
  for (const frame of shuffled.slice(1)) last = collector.add(frame);
  assert.equal(last, "complete");

  const decoded = await decodeSyncCode(collector.code());
  assert.equal(decoded.deviceName, "Alpha");
  assert.equal(decoded.requests.length, 2);
  assert.equal(decoded.requests[0].name, "Household 1");
  assert.equal("source" in decoded.requests[0], false, "local-only fields never leave the device");
  assert.equal(decoded.volunteers[0].name, "Sam");
});

test("incomplete or corrupted frames are detected, and a new code restarts collection", async () => {
  const codeA = await encodeSyncCode(buildSyncData({ requests: [request(1)], deviceName: "A" }));
  const framesA = makeFrames(codeA, 60);
  const collector = new FrameCollector();
  collector.add(framesA[0]);
  assert.throws(() => collector.code(), /missing/);
  assert.equal(collector.progress.have, 1);

  // frames of a different code replace the half-finished one
  const framesB = makeFrames(await encodeSyncCode(buildSyncData({ requests: [request(9)], deviceName: "B" })), 60);
  collector.add(framesB[0]);
  assert.equal(collector.progress.total, framesB.length);
  assert.equal(collector.progress.have, 1);

  // flipped character inside a frame is caught by the checksum
  const bad = new FrameCollector();
  framesA.forEach((frame, i) => bad.add(i === 1 ? frame.slice(0, -2) + (frame.endsWith("AA") ? "BB" : "AA") : frame));
  assert.throws(() => bad.code(), /do not match/);
  assert.equal(new FrameCollector().add("not a frame"), "ignored");
});

test("readSyncInput accepts a full code or pasted frame lines, rejects junk", async () => {
  const code = await encodeSyncCode(buildSyncData({ requests: [request(1)], deviceName: "A" }));
  assert.equal((await readSyncInput(code)).requests.length, 1);
  assert.equal((await readSyncInput(makeFrames(code, 80).join("\n"))).requests.length, 1);
  await assert.rejects(readSyncInput(""), /Nothing/);
  await assert.rejects(readSyncInput("hello"), /not a LIFELINE sync code/);
  await assert.rejects(readSyncInput("LS1:!!!notbase64"), /damaged/);
  await assert.rejects(decodeSyncCode("LS1:" + code.slice(4, 40)), /damaged/);
});

test("50 requests fit in a scannable number of QR frames", async () => {
  const requests = Array.from({ length: 50 }, (_, i) => request(i));
  const code = await encodeSyncCode(buildSyncData({ requests, deviceName: "Alpha" }));
  const frames = makeFrames(code);
  console.log(`      50 requests -> ${code.length} chars -> ${frames.length} frames of <=${FRAME_CHARS}`);
  assert.ok(frames.length <= 40, `too many frames: ${frames.length}`);
  assert.ok(frames.every((f) => f.length <= FRAME_CHARS + 30));
});
