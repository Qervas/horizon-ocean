/**
 * Measures whether the boat actually tracks the wave surface.
 *
 * Usage:
 *   node scripts/buoyancy-check.mjs            # real GPU (headed)
 *   node scripts/buoyancy-check.mjs --software # SwiftShader, for comparison
 *
 * Defaults to a HEADED browser because that is the only way to get the real
 * GPU. Forcing SwiftShader queues seconds of readback latency, which swamps the
 * thing being measured and makes the boat look broken when it is not.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const software = process.argv.includes("--software");
const PORT = 5188;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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

const args = software
  ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  : ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];

const browser = await chromium.launch({ headless: software, args });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/index.html`, {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForFunction(() => window.__lookdev, null, { timeout: 30000 });

const renderer = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});

await page.evaluate(() => window.__lookdev.playPlate());
// Let the probe warm up and the buoyancy spring settle.
await page.waitForTimeout(6000);

const stats = await page.evaluate(() => window.__lookdev.getStats());
const check = await page.evaluate(() => window.__lookdev.buoyancyCheck(120));
const slots = await page.evaluate(() => {
  const p = window.__oceanSim.getProbe ? window.__oceanSim.getProbe() : null;
  if (!p) return null;
  const ys = [];
  for (let i = 0; i < 8; i++) ys.push(Number(p.sample(i).y.toFixed(3)));
  return { slotY: ys, boatY: Number(window.__oceanSim.getBoat().y.toFixed(3)) };
});
if (slots) console.log("slots:", JSON.stringify(slots));
const trace = await page.evaluate(() => window.__lookdev.buoyancyTrace(6));
console.log("trace:");
for (const t of trace) console.log("  " + JSON.stringify(t));

console.log(
  JSON.stringify(
    { mode: software ? "software" : "real-gpu", renderer, fps: Math.round(stats.fps), ...check },
    null,
    2,
  ),
);
if (errors.length) console.error("page errors:\n  " + errors.join("\n  "));

await browser.close();
server.close();
