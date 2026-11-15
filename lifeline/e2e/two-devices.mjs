// End-to-end check with two real Chrome browser contexts paired over WebRTC.
// Usage: npm run build && npm run e2e   (needs Google Chrome installed)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4181; // own ports, so a running dev/share server is never reused
const API_PORT = 3011;
const URL = `http://localhost:${PORT}/`;

const server = spawn("npx", ["vite", "preview", "--port", String(PORT)], {
  stdio: "ignore",
  env: { ...process.env, LIFELINE_API: `http://127.0.0.1:${API_PORT}` },
});
// Triage server (rules mode: the key is blanked so no external AI call is made).
const api = spawn("node", ["../server/index.js"], {
  stdio: "ignore",
  env: { ...process.env, GEMINI_API_KEY: "", PORT: String(API_PORT) },
});
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(URL)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("preview server did not start");
}

async function newDevice(browser, name) {
  const context = await browser.newContext({
    geolocation: { latitude: 51.541, longitude: -0.145 },
    permissions: ["geolocation", "camera"],
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL);
  await page.getByLabel("This device's name").fill(name);
  await page.waitForSelector('[data-testid="request-row"]');
  return { page, context, errors, name };
}

async function createRequest(page, { name, description, gps = true, suggest = false }) {
  await page.getByRole("button", { name: /New request/  }).click();
  await page.getByLabel("Household or reporter name").fill(name);
  await page.getByLabel("Location / neighbourhood").fill("Camden Town");
  await page.getByLabel("Describe the situation").fill(description);
  if (suggest) {
    await page.getByRole("button", { name: /Suggest category and urgency/ }).click();
    await page.getByTestId("triage-result").waitFor();
    suggest.text = await page.getByTestId("triage-result").innerText();
    await page.getByTestId("triage-apply").click();
  }
  if (gps) {
    await page.getByRole("button", { name: /Use my current location/ }).click();
    await page.getByText("Location captured successfully").waitFor();
  }
  const submit = page.getByRole("button", { name: /Submit request/ });
  await submit.dblclick(); // double-click on purpose: must create ONE request
}

let browser;
try {
  await waitForServer();
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const A = await newDevice(browser, "Alpha");
  const B = await newDevice(browser, "Bravo");

  // ---- form validation + local creation + duplicate-click guard ----
  await A.page.getByRole("button", { name: /New request/  }).click();
  await A.page.getByRole("button", { name: /Submit request/ }).click();
  check("empty form is blocked by validation", await A.page.getByLabel("Household or reporter name").evaluate((el) => !el.validity.valid));
  await A.page.getByRole("button", { name: "Cancel" }).click();

  await createRequest(A.page, { name: "Offline Household", description: "Need water before pairing" });
  await A.page.getByText(/saved on this device only/).waitFor();
  const rowsA = A.page.locator('[data-id^="SOS-"][data-id*="-"]').filter({ hasText: "Offline Household" });
  check("double-click creates exactly one request", (await rowsA.count()) === 1);
  check("offline request says it is local only", /No device is connected/.test(await A.page.getByTestId("transfer-status").innerText()));
  check("request has a map marker", (await A.page.locator(".custom-marker").count()) >= 5);

  await A.page.reload();
  await A.page.waitForSelector('[data-testid="request-row"]');
  check("request survives a refresh", (await A.page.getByText("Offline Household").count()) === 1);

  // ---- pairing via copy/paste codes ----
  await A.page.getByRole("button", { name: /Create pairing QR/ }).click();
  await A.page.locator('summary:has-text("Copy the code")').click();
  const offer = await A.page.getByTestId("pairing-code").inputValue();
  check("offer code produced", offer.length > 100);

  await B.page.getByRole("button", { name: "Scan pairing QR" }).click();
  await B.page.getByTestId("pairing-input").fill(offer);
  await B.page.getByRole("button", { name: "Process pairing code" }).click();
  await B.page.locator('summary:has-text("Copy the code")').click();
  const answer = await B.page.getByTestId("pairing-code").inputValue();
  check("answer code produced", answer.length > 100);

  await A.page.getByRole("button", { name: "Scan answer QR" }).click();
  await A.page.getByTestId("pairing-input").fill(answer);
  await A.page.getByRole("button", { name: "Process pairing code" }).click();

  await A.page.getByTestId("network-pill").getByText(/Connected to 1 device/).waitFor({ timeout: 30000 });
  await B.page.getByTestId("network-pill").getByText(/Connected to 1 device/).waitFor({ timeout: 30000 });
  check("both devices report OPEN data channel", true);
  for (const d of [A, B]) {
    const log = await d.page.getByTestId("network-log").innerText();
    check(`${d.name}: real local address exposed (not hidden behind .local)`, /Camera permission granted/.test(log) && !/hidden behind/.test(log));
  }

  // backlog sync on connect
  await B.page.getByText("Offline Household").first().waitFor({ timeout: 10000 });
  check("request created before pairing synced to B", true);

  // ---- live SOS transfer + ACK ----
  await createRequest(A.page, { name: "Live Household", description: "Insulin needed urgently" });
  await B.page.getByText("Live Household").first().waitFor({ timeout: 10000 });
  check("new SOS from A appears on B dashboard", true);
  await A.page.getByText(/Delivered to Bravo/).first().waitFor({ timeout: 10000 });
  check("A shows delivery only after B's ACK", true);
  check("B shows the SOS on its map", (await B.page.locator(".custom-marker").count()) >= 6);

  // ---- status update propagates ----
  const bRow = B.page.locator('[data-testid="request-row"]').filter({ hasText: "Live Household" });
  await bRow.getByTestId("status-select").selectOption("Assigned");
  await A.page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid="request-row"]')];
    const row = rows.find((r) => r.textContent.includes("Live Household"));
    return row?.querySelector("select")?.value === "Assigned";
  }, null, { timeout: 10000 });
  check("status change on B propagates to A", true);

  // ---- AI triage through the server ----
  const triage = {};
  await createRequest(A.page, { name: "Thirsty Household", description: "No drinking water, family of 4", suggest: triage });
  check("triage suggestion comes from the LIFELINE server", /LIFELINE server rules/.test(triage.text));
  await B.page.getByText("Thirsty Household").first().waitFor({ timeout: 10000 });
  check("triage-applied category and people are on the saved request", /Water supplies · Camden Town · 4 people/.test(
    await A.page.locator('[data-testid="request-row"]').filter({ hasText: "Thirsty Household" }).innerText()));

  // ---- volunteers: register on B, sync to A ----
  const panelB = B.page.getByTestId("volunteer-panel");
  await panelB.getByRole("button", { name: "Register as volunteer" }).click();
  check("volunteer needs at least one skill", await panelB.getByRole("alert").isVisible());
  await panelB.getByLabel("Volunteer name").fill("Bravo Vol");
  await panelB.getByLabel("Water supplies").check();
  await panelB.getByLabel("Area you can cover").fill("Camden");
  await panelB.getByLabel("People you can help at once").fill("5");
  await panelB.getByRole("button", { name: "Register as volunteer" }).click();
  await panelB.getByTestId("my-profile").waitFor();
  check("volunteer profile saved on B", true);
  await A.page.getByTestId("volunteer-row").filter({ hasText: "Bravo Vol" }).waitFor({ timeout: 10000 });
  check("volunteer synced to A", true);

  // ---- matching and assignment ----
  const thirstyA = A.page.locator('[data-testid="request-row"]').filter({ hasText: "Thirsty Household" });
  await thirstyA.locator('[data-testid="matches"] summary').click();
  check("A shows Bravo Vol as a match for the water request", /1 volunteer can help/.test(await thirstyA.getByTestId("matches").innerText()));
  const medicalA = A.page.locator('[data-testid="request-row"]').filter({ hasText: "Offline Household" });
  check("medical request has no water volunteer match", /No available volunteer matches/.test(await medicalA.getByTestId("matches").innerText()));
  check("uncovered-request warning is shown", await A.page.getByTestId("uncovered").isVisible());
  await thirstyA.getByTestId("assign-button").click();
  await A.page.waitForFunction(() => {
    const row = [...document.querySelectorAll('[data-testid="request-row"]')].find((r) => r.textContent.includes("Thirsty Household"));
    return row?.querySelector("select")?.value === "Assigned" && row.textContent.includes("Assigned to Bravo Vol");
  }, null, { timeout: 10000 });
  check("A: assignment sets status Assigned and shows the volunteer", true);
  await B.page.waitForFunction(() => {
    const row = [...document.querySelectorAll('[data-testid="request-row"]')].find((r) => r.textContent.includes("Thirsty Household"));
    return row?.querySelector("select")?.value === "Assigned" && row.textContent.includes("Assigned to Bravo Vol");
  }, null, { timeout: 10000 });
  check("B: assignment synced to the volunteer's own device", true);

  // reopening releases the volunteer on both devices
  await thirstyA.getByTestId("status-select").selectOption("Open");
  await B.page.waitForFunction(() => {
    const row = [...document.querySelectorAll('[data-testid="request-row"]')].find((r) => r.textContent.includes("Thirsty Household"));
    return row?.querySelector("select")?.value === "Open" && !row.textContent.includes("Assigned to");
  }, null, { timeout: 10000 });
  check("reopening releases the volunteer on B", true);

  // volunteer takes a request themselves
  const takeThirsty = panelB.locator("li").filter({ hasText: "Thirsty Household" }).getByTestId("take-button");
  await takeThirsty.waitFor();
  await takeThirsty.click();
  await A.page.waitForFunction(() => document.body.textContent.includes("Assigned to Bravo Vol"), null, { timeout: 10000 });
  check("volunteer self-assignment on B reaches A", true);

  // capacity: B now helps 4 of 5 people, so a 3-person water request must not be assignable
  await B.page.getByTestId("my-capacity").getByText("Helping 4 of 5").waitFor({ timeout: 10000 });
  check("B's profile shows the load: Helping 4 of 5", true);
  await A.page.getByTestId("volunteer-row").filter({ hasText: "Bravo Vol" }).getByText(/Helping 4 of 5/).waitFor({ timeout: 10000 });
  check("A sees B's load computed from synced requests", true);

  const tight = {};
  await createRequest(A.page, { name: "Big Household", description: "Need drinking water for 3 people", suggest: tight });
  const bigA = A.page.locator('[data-testid="request-row"]').filter({ hasText: "Big Household" });
  await bigA.waitFor();
  await bigA.locator('[data-testid="matches"] summary').click();
  check("over-capacity volunteer is flagged and Assign is disabled",
    /Needs room for 3, has 1/.test(await bigA.getByTestId("capacity-note").innerText()) &&
    (await bigA.getByTestId("assign-button").isDisabled()));
  await B.page.getByText("Big Household").first().waitFor({ timeout: 10000 });
  const takeBig = B.page.getByTestId("volunteer-panel").locator("li").filter({ hasText: "Big Household" }).getByTestId("take-button");
  check("the volunteer's own Take button is disabled too", await takeBig.isDisabled());

  // resolving a request frees capacity
  const thirstyB = B.page.locator('[data-testid="request-row"]').filter({ hasText: "Thirsty Household" });
  await thirstyB.getByTestId("status-select").selectOption("Resolved");
  await B.page.getByTestId("my-capacity").getByText("Helping 0 of 5").waitFor({ timeout: 10000 });
  await bigA.getByTestId("assign-button").and(A.page.locator(":enabled")).waitFor({ timeout: 10000 });
  check("resolving a request frees capacity and Assign becomes available", true);

  // availability
  await panelB.getByRole("button", { name: "Mark not available" }).click();
  await A.page.getByTestId("volunteer-row").filter({ hasText: "Bravo Vol" }).getByText("Not available").waitFor({ timeout: 10000 });
  check("availability change synced to A", true);

  // ---- disconnect handling ----
  await A.page.getByRole("button", { name: "Disconnect" }).click();
  await A.page.getByTestId("network-pill").getByText(/Not connected/).waitFor();
  await B.page.getByTestId("network-pill").getByText(/Not connected/).waitFor({ timeout: 15000 });
  check("disconnect is reflected on both devices", true);

  // ---- persistence on receiver ----
  await B.page.reload();
  await B.page.waitForSelector('[data-testid="request-row"]');
  check("received request persists on B after refresh", (await B.page.getByText("Live Household").count()) === 1);
  await B.page.getByTestId("my-profile").waitFor();
  check("volunteer profile persists on B after refresh", true);
  check("assignment persists on B after refresh", (await B.page.getByText("Assigned to Bravo Vol").count()) >= 1);

  // ---- mobile layout ----
  await A.page.setViewportSize({ width: 390, height: 800 });
  const overflow = await A.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("no horizontal overflow at 390px", !overflow);

  for (const d of [A, B]) {
    const bad = d.errors.filter((e) => !/tile\.openstreetmap|ERR_|Failed to load resource|fonts\.g/.test(e));
    check(`${d.name}: no console/page errors`, bad.length === 0);
    if (bad.length) console.log(bad);
  }
} catch (error) {
  console.error("E2E ERROR:", error.message);
  results.push(["e2e run", false]);
} finally {
  await browser?.close();
  server.kill();
  api.kill();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
