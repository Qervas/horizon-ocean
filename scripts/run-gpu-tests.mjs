/**
 * Runs the WebGL test suite in a real browser.
 *
 * Spawns its own static server so `npm run test:gpu` is self-contained.
 * Headless Chromium needs SwiftShader flags to expose a WebGL2 context with
 * EXT_color_buffer_float; without them every float-render-target test fails
 * for reasons unrelated to the code under test.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

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
      // normalize() collapses ".." before we join, so requests cannot escape root.
      const rel = normalize(urlPath).replace(/^([/\\])+/, "");
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

const PORT = Number(process.env.OCEAN_TEST_PORT || 5174);
const server = await startServer(PORT);

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${PORT}/tests/gpu/harness.html`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__gpuTestsReady === true, null, { timeout: 60000 });

  const loadError = await page.evaluate(() => window.__gpuTestsLoadError || null);
  if (loadError) throw new Error(`test module failed to load:\n${loadError}`);

  const results = await page.evaluate(() => window.__gpuTests.runAll());

  let passed = 0;
  for (const r of results) {
    if (r.ok) {
      passed++;
      console.log(`  ok    ${r.name}`);
    } else {
      console.log(`  FAIL  ${r.name}\n        ${r.error.split("\n").join("\n        ")}`);
    }
  }
  console.log(`\n${passed}/${results.length} GPU tests passed`);
  if (passed !== results.length) exitCode = 1;
  if (results.length === 0) {
    console.log("no GPU tests registered");
    exitCode = 1;
  }
} catch (e) {
  console.error(String(e));
  if (consoleErrors.length) console.error("page errors:\n  " + consoleErrors.join("\n  "));
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

process.exit(exitCode);
