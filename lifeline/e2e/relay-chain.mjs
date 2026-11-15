// Three browsers in a chain A<->B<->C. A's SOS must reach C through B (relay),
// C's ACK must not be faked, and C's status change must flow back to A.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4182; // no API server on purpose: triage must fall back to the device
const URL = `http://localhost:${PORT}/`;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT)], {
  stdio: "ignore",
  env: { ...process.env, LIFELINE_API: "http://127.0.0.1:3019" }, // nothing listens here
});
const results = [];
const check = (n, ok) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

async function device(browser, name) {
  const ctx = await browser.newContext({ geolocation: { latitude: 51.54, longitude: -0.14 }, permissions: ["geolocation", "camera"] });
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.getByLabel("This device's name").fill(name);
  return page;
}

// `offerer` creates the code, `answerer` answers it.
async function pair(offerer, answerer) {
  await offerer.getByRole("button", { name: /pairing QR \(create QR\)|Create pairing QR/ }).click();
  await offerer.locator('summary:has-text("Copy the code")').click();
  const offer = await offerer.getByTestId("pairing-code").inputValue();
  await answerer.getByRole("button", { name: "Scan pairing QR" }).click();
  await answerer.getByTestId("pairing-input").fill(offer);
  await answerer.getByRole("button", { name: "Process pairing code" }).click();
  await answerer.locator('summary:has-text("Copy the code")').click();
  const answer = await answerer.getByTestId("pairing-code").inputValue();
  await offerer.getByRole("button", { name: "Scan answer QR" }).click();
  await offerer.getByTestId("pairing-input").fill(answer);
  await offerer.getByRole("button", { name: "Process pairing code" }).click();
}

let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); }
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const A = await device(browser, "Alpha"), B = await device(browser, "Bravo"), C = await device(browser, "Charlie");

  await pair(A, B);
  await B.getByTestId("network-pill").getByText(/Connected to 1 device/).waitFor({ timeout: 30000 });
  await pair(C, B); // C joins B; B now has two links
  await B.getByTestId("network-pill").getByText(/Connected to 2 devices/).waitFor({ timeout: 30000 });
  check("B holds two simultaneous open links", true);
  check("C is NOT directly connected to A", (await C.getByTestId("network-pill").innerText()).includes("1 device"));

  await A.getByRole("button", { name: /New request/  }).click();
  await A.getByLabel("Household or reporter name").fill("Relay Household");
  await A.getByLabel("Location / neighbourhood").fill("Chalk Farm");
  await A.getByLabel("Describe the situation").fill("Trapped upstairs");
  await A.getByRole("button", { name: /Use my current location/ }).click();
  await A.getByText("Location captured successfully").waitFor();
  await A.getByRole("button", { name: /Submit request/ }).click();

  await C.getByText("Relay Household").first().waitFor({ timeout: 15000 });
  check("A's SOS reached C via B's relay", true);
  check("C shows it came from B (honest provenance)", /From Bravo/.test(await C.locator('[data-testid="request-row"]').filter({ hasText: "Relay Household" }).innerText()));

  await C.locator('[data-testid="request-row"]').filter({ hasText: "Relay Household" }).getByTestId("status-select").selectOption("Resolved");
  await A.waitForFunction(() => {
    const row = [...document.querySelectorAll('[data-testid="request-row"]')].find((r) => r.textContent.includes("Relay Household"));
    return row?.querySelector("select")?.value === "Resolved";
  }, null, { timeout: 15000 });
  check("C's status change reached A through B", true);

  // volunteer registered on C is relayed to A through B
  await C.getByTestId("volunteer-panel").getByLabel("Volunteer name").fill("Charlie Vol");
  await C.getByTestId("volunteer-panel").getByLabel("Shelter").check();
  await C.getByTestId("volunteer-panel").getByRole("button", { name: "Register as volunteer" }).click();
  await A.getByTestId("volunteer-row").filter({ hasText: "Charlie Vol" }).waitFor({ timeout: 15000 });
  check("volunteer from C reached A through B", true);

  // triage with NO server running falls back to on-device rules
  await A.getByRole("button", { name: /New request/ }).click();
  await A.getByLabel("Describe the situation").fill("Man unconscious and not breathing");
  await A.getByRole("button", { name: /Suggest category and urgency/ }).click();
  const text = await A.getByTestId("triage-result").innerText();
  check("offline triage uses on-device rules and flags Critical", /on-device rules/.test(text) && /Critical/.test(text) && /Medical assistance/.test(text));
} catch (e) {
  console.error("E2E ERROR:", e.message);
  results.push(false);
} finally {
  await browser?.close();
  server.kill();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
