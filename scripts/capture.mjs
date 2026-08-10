/**
 * Headless capture for the look-dev goal loop.
 *
 * Usage: node scripts/capture.mjs [wave-name] [title|play] [--debug=N]
 *
 * Spawns its own static server, fails on any console/page error, and prints
 * frame time and draw-call stats alongside the image path.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const wave = process.argv[2] || "wave";
const plate = process.argv[3] || "title";
const debugArg = process.argv.find((a) => a.startsWith("--debug="));
const debugMode = debugArg ? Number(debugArg.split("=")[1]) : 0;
// Software rendering queues seconds of probe readback, so any plate containing
// the boat must be captured on the real GPU or the hull will look adrift.
const realGpu = process.argv.includes("--gpu");
const tierArg = process.argv.find((a) => a.startsWith("--tier="));
const forcedTier = tierArg ? tierArg.split("=")[1] : null;
const wxArg = process.argv.find((a) => a.startsWith("--weather="));
const weather = wxArg ? wxArg.split("=")[1] : null;
// Drives the boat before capturing, so the wake trail has something in it.
const driveArg = process.argv.find((a) => a.startsWith("--drive="));
const driveSeconds = driveArg ? Number(driveArg.split("=")[1]) : 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function startServer(port) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^([/\\])+/, "");
      const file = join(root, rel);
      if (!file.startsWith(root)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const PORT = Number(process.env.OCEAN_TEST_PORT || 5175);
const server = await startServer(PORT);
const outDir = join(root, "ref", "captures");
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `${wave}-${plate}.png`);

const browser = await chromium.launch({
  headless: !realGpu,
  args: realGpu
    ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"]
    : [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => {
  // A missing favicon is not a rendering failure; everything else is.
  if (m.type() === "error" && !/favicon/i.test(m.location()?.url ?? "")) {
    errors.push(`${m.text()} @ ${m.location()?.url ?? "?"}`);
  }
});
page.on("pageerror", (e) => errors.push(String(e)));

let exitCode = 0;
try {
  const query = forcedTier ? `?tier=${forcedTier}` : "";
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__lookdev && window.__oceanSim, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  if (driveSeconds > 0) {
    await page.evaluate(() => {
      window.__lookdev.playPlate();
      window.__controlsTest.setKeys(["KeyW"]);
    });
    await page.waitForTimeout(driveSeconds * 1000);
    await page.evaluate(() => window.__controlsTest.setKeys([]));
  }
  await page.evaluate(
    ({ plate, debugMode }) => {
      if (plate === "play") window.__lookdev.playPlate();
      else if (plate === "boat") window.__lookdev.boatPlate();
      else window.__lookdev.titlePlate();
      window.__lookdev.hideHud();
      if (debugMode) window.__lookdev.debugCascade(debugMode);
    },
    { plate, debugMode },
  );
  // Weather must be applied AFTER the plate: titlePlate() forces calm, so
  // setting it first silently captured calm for every --weather run.
  if (weather) await page.evaluate((w) => window.__lookdev.setWeather(w), weather);
  await page.waitForTimeout(2500);

  const stats = await page.evaluate(() => window.__lookdev.getStats());
  await page.screenshot({ path: outPath, type: "png" });

  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        path: outPath,
        plate,
        wave,
        tier: stats.tier,
        fps: Math.round(stats.fps),
        frameMs: Number(stats.frameMs.toFixed(2)),
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        probeLatencyMs: Number((stats.probeLatency * 1000).toFixed(1)),
        probeReady: stats.probeReady,
        probeInFlight: stats.probeInFlight,
        probeSample0: stats.probeSample0,
        boatY: stats.boatY,
        errors,
      },
      null,
      2,
    ),
  );
  if (errors.length) exitCode = 1;
} catch (e) {
  console.error(String(e));
  if (errors.length) console.error("page errors:\n  " + errors.join("\n  "));
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

process.exit(exitCode);
