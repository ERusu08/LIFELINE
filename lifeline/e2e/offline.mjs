// Two browsers with the NETWORK CUT. Proves: the app opens offline (service
// worker), and requests/volunteers move between devices by sync code and by
// file with no network at all.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4184;
const URL = `http://localhost:${PORT}/`;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT)], { stdio: "ignore" });
const results = [];
const check = (n, ok) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

async function device(browser, name) {
  const context = await browser.newContext({ geolocation: { latitude: 51.54, longitude: -0.14 }, permissions: ["geolocation"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  await page.getByLabel("This device's name").fill(name);
  await page.waitForSelector('[data-testid="request-row"]');
  // wait for the service worker to take control (needs one reload after install)
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('[data-testid="request-row"]');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return { page, context, errors, name };
}

async function makeRequest(page, name, description) {
  await page.getByRole("button", { name: /New request/ }).click();
  await page.getByLabel("Household or reporter name").fill(name);
  await page.getByLabel("Location / neighbourhood").fill("Camden Town");
  await page.getByLabel("Describe the situation").fill(description);
  await page.getByRole("button", { name: /Use my current location/ }).click();
  await page.getByText("Location captured successfully").waitFor();
  await page.getByRole("button", { name: /Submit request/ }).click();
  await page.locator('[data-testid="request-row"]').filter({ hasText: name }).waitFor();
}

const row = (page, text) => page.locator('[data-testid="request-row"]').filter({ hasText: text });
const syncPanel = (page) => page.getByTestId("offline-sync");

let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); }
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const A = await device(browser, "Alpha");
  const B = await device(browser, "Bravo");
  check("service worker controls both pages", true);

  await makeRequest(A.page, "Offline Alpha", "Need water, family of 3");
  const v = A.page.getByTestId("volunteer-panel");
  await v.getByLabel("Volunteer name").fill("Alpha Vol");
  await v.getByLabel("Transport").check();
  await v.getByRole("button", { name: "Register as volunteer" }).click();
  await v.getByTestId("my-profile").waitFor();
  await makeRequest(B.page, "Offline Bravo", "Need insulin urgently");

  // ---- CUT THE NETWORK ----
  await A.context.setOffline(true);
  await B.context.setOffline(true);
  await A.page.reload();
  await B.page.reload();
  await A.page.waitForSelector('[data-testid="request-row"]', { timeout: 15000 });
  await B.page.waitForSelector('[data-testid="request-row"]', { timeout: 15000 });
  check("app reloads and opens with NO network (both devices)", true);
  check("A's saved request is still there offline", (await row(A.page, "Offline Alpha").count()) === 1);

  // ---- A -> B by sync code ----
  await syncPanel(A.page).getByRole("button", { name: "Show my data as QR" }).click();
  const code = await A.page.getByTestId("sync-code").inputValue();
  check("A shows a sync code and QR frame counter", code.startsWith("LS1:") && /Frame 1 of \d+/.test(await A.page.getByTestId("sync-frame-counter").innerText()));
  // The rendered QR image must decode (same scanner library the app uses).
  const qrPng = join(mkdtempSync(join(tmpdir(), "lifeline-qr-")), "frame.png");
  const pause = syncPanel(A.page).getByRole("button", { name: "Pause" });
  if (await pause.count()) await pause.click(); // freeze the loop so the screenshot is one whole frame
  await A.page.locator(".qr-frame").screenshot({ path: qrPng });
  const reader = await A.context.newPage();
  await reader.goto("about:blank");
  await reader.addScriptTag({ path: "node_modules/html5-qrcode/html5-qrcode.min.js" });
  await reader.setContent('<div id="r"></div><input type="file" id="f">');
  await reader.setInputFiles("#f", qrPng);
  const decoded = await reader.evaluate(async () => {
    const file = document.getElementById("f").files[0];
    try { return await new Html5Qrcode("r").scanFile(file, false); } catch (e) { return "ERR " + e; }
  });
  await reader.close();
  const [, , index, total, ...rest] = decoded.split(".");
  const size = 400;
  const expectedSlice = code.slice(Number(index) * size, (Number(index) + 1) * size).replace(/:/g, "~");
  check("the rendered QR image decodes back to the exact frame", Number(total) === Math.ceil(code.length / size) && rest.join(".") === expectedSlice);
  console.log(`      decoded frame ${Number(index) + 1}/${total}, ${decoded.length} chars`);
  await syncPanel(A.page).getByRole("button", { name: "Done" }).click();

  await syncPanel(B.page).getByRole("button", { name: "Scan another device" }).click();
  await B.page.getByTestId("sync-input").fill(code);
  await B.page.getByRole("button", { name: "Import code" }).click();
  await B.page.getByTestId("sync-result").getByText(/Received 1 new request, 1 volunteer from Alpha/).waitFor();
  check("B imports A's request and volunteer from the code", true);
  check("B shows the request with its source", /From Alpha/.test(await row(B.page, "Offline Alpha").innerText()));
  check("B has a map marker for it", (await B.page.locator(".custom-marker").count()) >= 6);
  check("B lists the volunteer", (await B.page.getByTestId("volunteer-row").filter({ hasText: "Alpha Vol" }).count()) === 1);

  // importing the same code again changes nothing
  await B.page.getByTestId("sync-input").fill(code);
  await B.page.getByRole("button", { name: "Import code" }).click();
  await B.page.getByTestId("sync-result").getByText(/Nothing new from Alpha/).waitFor();
  check("importing twice creates no duplicates", (await row(B.page, "Offline Alpha").count()) === 1);

  // bad input is rejected with a clear message
  await B.page.getByTestId("sync-input").fill("hello world");
  await B.page.getByRole("button", { name: "Import code" }).click();
  check("junk input is rejected", /not a LIFELINE sync code/.test(await B.page.getByTestId("sync-result").innerText()));
  await B.page.getByTestId("sync-input").fill(code.slice(0, 20) + "AAAA" + code.slice(24, code.length - 8));
  await B.page.getByRole("button", { name: "Import code" }).click();
  check("damaged code is rejected", /damaged|Import failed/.test(await B.page.getByTestId("sync-result").innerText()));

  // ---- B -> A by FILE ----
  await B.page.getByRole("button", { name: "Back" }).click();
  const downloadPromise = B.page.waitForEvent("download");
  await syncPanel(B.page).getByRole("button", { name: "Save as file" }).click();
  const download = await downloadPromise;
  const file = join(mkdtempSync(join(tmpdir(), "lifeline-")), download.suggestedFilename());
  await download.saveAs(file);
  check("B saved a .lifeline file", file.endsWith(".lifeline"));

  await A.page.getByTestId("sync-file").setInputFiles(file);
  await A.page.getByTestId("sync-result").getByText(/Received .* from Bravo/).waitFor();
  check("A imports B's data from the file", (await row(A.page, "Offline Bravo").count()) === 1);
  check("A keeps its own request after importing", (await row(A.page, "Offline Alpha").count()) === 1);

  // ---- survives refresh, still offline ----
  await B.page.reload();
  await B.page.waitForSelector('[data-testid="request-row"]');
  check("imported data persists after an offline refresh", (await row(B.page, "Offline Alpha").count()) === 1);

  for (const d of [A, B]) {
    check(`${d.name}: no page errors`, d.errors.length === 0);
    if (d.errors.length) console.log(d.errors);
  }
} catch (e) {
  console.error("E2E ERROR:", e.message);
  results.push(false);
} finally {
  await browser?.close();
  server.kill();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
