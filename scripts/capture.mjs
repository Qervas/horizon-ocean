/**
 * Headless capture for look-dev goal loop.
 * Usage: node scripts/capture.mjs [wave-name] [title|play]
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const wave = process.argv[2] || "wave";
const plate = process.argv[3] || "title";
const base = process.env.OCEAN_URL || "http://127.0.0.1:5173";
const outDir = join(root, "ref", "captures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${wave}-${plate}.png`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
});

await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });
// Wait for sim + FFT warm-up
await page.waitForFunction(() => window.__lookdev && window.__oceanSim, null, {
  timeout: 30000,
});
await page.waitForTimeout(1500);

if (plate === "play") {
  await page.evaluate(() => window.__lookdev.playPlate());
} else {
  await page.evaluate(() => window.__lookdev.titlePlate());
}
await page.evaluate(() => window.__lookdev.hideHud());
// Let a few frames settle after camera snap
await page.waitForTimeout(2000);

await page.screenshot({ path: outPath, type: "png" });
console.log(JSON.stringify({ ok: true, path: outPath, plate, wave }));
await browser.close();
