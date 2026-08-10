/**
 * Measures whether the boat actually tracks the wave surface.
 *
 * Usage: node scripts/buoyancy-check.mjs <project-root>
 *
 * CAVEAT: run this against real hardware, not the SwiftShader path used by the
 * capture scripts. Software rendering queues ~2 s of readback latency, which
 * swamps what this is trying to measure.
 *
 * KNOWN ISSUE: probe.sampleSync() currently reports a constant, so the reported
 * rms/peak error is measured against a broken reference and is not meaningful.
 * The latency figure is sound. Fix sampleSync before trusting the rest.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const root = process.argv[2];
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
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
await new Promise((r) => server.listen(5177, "127.0.0.1", r));

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

await page.goto("http://127.0.0.1:5177/index.html", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => window.__lookdev, null, { timeout: 30000 });
await page.evaluate(() => window.__lookdev.playPlate());
await page.waitForTimeout(5000);

const result = await page.evaluate(() => window.__lookdev.buoyancyCheck(60));
console.log(JSON.stringify(result, null, 2));
if (errs.length) console.error("page errors:", errs.join("\n"));

await browser.close();
server.close();
