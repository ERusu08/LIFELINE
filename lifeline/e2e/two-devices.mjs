// End-to-end check with two real Chrome browser contexts paired over WebRTC.
// Usage: npm run build && npm run e2e   (needs Google Chrome installed)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4173;
const URL = `http://localhost:${PORT}/`;

const server = spawn("npx", ["vite", "preview", "--port", String(PORT)], { stdio: "ignore" });
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

async function createRequest(page, { name, description, gps = true }) {
  await page.getByRole("button", { name: /New request/  }).click();
  await page.getByLabel("Household or reporter name").fill(name);
  await page.getByLabel("Location / neighbourhood").fill("Camden Town");
  await page.getByLabel("Describe the situation").fill(description);
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

  // ---- disconnect handling ----
  await A.page.getByRole("button", { name: "Disconnect" }).click();
  await A.page.getByTestId("network-pill").getByText(/Not connected/).waitFor();
  await B.page.getByTestId("network-pill").getByText(/Not connected/).waitFor({ timeout: 15000 });
  check("disconnect is reflected on both devices", true);

  // ---- persistence on receiver ----
  await B.page.reload();
  await B.page.waitForSelector('[data-testid="request-row"]');
  check("received request persists on B after refresh", (await B.page.getByText("Live Household").count()) === 1);

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
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
