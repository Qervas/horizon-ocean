/**
 * Captures every sea state and plate from fixed cameras in one browser session,
 * then composites them into a single sheet.
 *
 * Usage: node scripts/contact-sheet.mjs [name]
 *
 * WHY THIS EXISTS
 *
 * Look changes were being judged from one lucky frame at one camera angle, and
 * foam alone overshot three times — invisible, then painted white, then a faint
 * wisp — because nothing showed the states side by side. A single sheet makes a
 * regression in one state obvious while another looks fine.
 *
 * Runs on the real GPU by default; software rendering queues seconds of probe
 * readback and misrepresents anything containing the boat.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2] || "sheet";
const software = process.argv.includes("--software");
const PORT = 5191;
const W = 800;
const H = 450;

/** Each cell: a label, the plate to set up, and any weather/driving. */
const CELLS = [
  { label: "calm", plate: "title", weather: "calm" },
  { label: "moderate", plate: "title", weather: "moderate" },
  { label: "storm", plate: "title", weather: "storm" },
  { label: "boat calm", plate: "boat", weather: "calm" },
  { label: "boat storm", plate: "boat", weather: "storm" },
  { label: "wake", plate: "play", weather: "moderate", drive: 8 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const rel = normalize(u === "/" ? "/index.html" : u).replace(/^[/\\]+/, "");
    const body = await readFile(join(root, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch({
  headless: software,
  args: software
    ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : ["--use-angle=d3d11", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => window.__lookdev, null, { timeout: 30000 });

const outDir = join(root, "ref", "captures", "sheet");
await mkdir(outDir, { recursive: true });
const paths = [];

for (const cell of CELLS) {
  await page.evaluate((w) => window.__lookdev.setWeather(w), cell.weather);
  if (cell.drive) {
    await page.evaluate(() => {
      window.__lookdev.playPlate();
      window.__controlsTest.setKeys(["KeyW"]);
    });
    await page.waitForTimeout(cell.drive * 1000);
    await page.evaluate(() => window.__controlsTest.setKeys([]));
  }
  await page.evaluate((p) => {
    if (p === "play") window.__lookdev.playPlate();
    else if (p === "boat") window.__lookdev.boatPlate();
    else window.__lookdev.titlePlate();
    window.__lookdev.hideHud();
  }, cell.plate);
  // Weather must be re-applied: titlePlate() forces calm.
  await page.evaluate((w) => window.__lookdev.setWeather(w), cell.weather);
  await page.waitForTimeout(2500);

  const file = join(outDir, `${cell.label.replace(/\s+/g, "-")}.png`);
  await page.screenshot({ path: file, type: "png" });
  paths.push({ file, label: cell.label });
}

const stats = await page.evaluate(() => window.__lookdev.getStats());
await browser.close();
server.close();

const manifest = join(outDir, "manifest.json");
await writeFile(
  manifest,
  JSON.stringify({ name, cells: paths, tier: stats.tier, errors }, null, 2),
);

console.log(JSON.stringify({ ok: errors.length === 0, outDir, cells: paths.length, errors }, null, 2));
process.exit(errors.length ? 1 : 0);
