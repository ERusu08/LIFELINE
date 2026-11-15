import { test } from "node:test";
import assert from "node:assert/strict";
import { triageLocally, fromServerTriage, suggestTriage } from "./triage.js";

test("local triage: category, urgency and people", () => {
  assert.deepEqual(triageLocally("Two people trapped, one bleeding heavily"), {
    category: "Medical assistance", urgency: "Critical", people: 2, source: "device",
  });
  assert.equal(triageLocally("we need drinking water, family of 4").category, "Water supplies");
  assert.equal(triageLocally("we need drinking water, family of 4").people, 4);
  assert.equal(triageLocally("no food for the baby").category, "Food supplies");
  assert.equal(triageLocally("no food for the baby").urgency, "High");
  assert.equal(triageLocally("need a lift to the shelter, no rush").category, "Transport");
  assert.equal(triageLocally("need a lift to the shelter, no rush").urgency, "Low");
  assert.equal(triageLocally("our roof is gone and we have nowhere to sleep").category, "Shelter");
  assert.equal(triageLocally("something happened").category, "Other");
  assert.equal(triageLocally("something happened").urgency, "Medium");
  assert.equal(triageLocally("something happened").people, null);
});

test("server triage is mapped into app fields; junk is rejected", () => {
  const mapped = fromServerTriage({ type: "SUPPLIES", urgency: "high", source: "gemini", peopleAffected: 5 }, "need water");
  assert.deepEqual(mapped, { category: "Water supplies", urgency: "High", people: 5, source: "gemini" });
  assert.equal(fromServerTriage({ type: "MEDICAL", urgency: "critical", source: "rules" }, "x").category, "Medical assistance");
  assert.equal(fromServerTriage({ type: "MEDICAL", urgency: "critical", source: "rules" }, "x").source, "server");
  assert.equal(fromServerTriage({ urgency: "bogus" }, "x"), null);
  assert.equal(fromServerTriage(null, "x"), null);
});

test("suggestTriage uses the server, and falls back to the device when it fails", async () => {
  const good = async () => ({ ok: true, json: async () => ({ type: "MEDICAL", urgency: "critical", source: "gemini", peopleAffected: 1 }) });
  assert.equal((await suggestTriage("bleeding badly", { fetchImpl: good })).source, "gemini");

  const down = async () => { throw new Error("ECONNREFUSED"); };
  const offline = await suggestTriage("bleeding heavily", { fetchImpl: down });
  assert.equal(offline.source, "device");
  assert.equal(offline.urgency, "Critical");

  const bad = async () => ({ ok: false, json: async () => ({}) });
  assert.equal((await suggestTriage("need water", { fetchImpl: bad })).source, "device");
  const garbage = async () => ({ ok: true, json: async () => ({ nonsense: 1 }) });
  assert.equal((await suggestTriage("need water", { fetchImpl: garbage })).source, "device");
  assert.equal(await suggestTriage("   "), null);
});
