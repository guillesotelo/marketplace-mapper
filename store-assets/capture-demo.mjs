// Captures store-assets/demo-src.html as an animated GIF + MP4.
//
//   node store-assets/build-demo.js && node store-assets/capture-demo.mjs
//
// Requires playwright-core (any local install) and ffmpeg on PATH.
// If this import fails: npm i playwright-core   (and have a Chromium available,
// either from a playwright install or via CHROME_PATH=/path/to/Chrome)
import { chromium } from "playwright-core";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const frames = path.join(dir, ".frames");
const FPS = 12;
const MAX_SECONDS = 45;

const EXE = process.env.CHROME_PATH
  || `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

fs.rmSync(frames, { recursive: true, force: true });
fs.mkdirSync(frames, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

page.on("pageerror", e => console.log("PAGE ERROR:", e.message));

await page.goto("file://" + path.join(dir, "demo-src.html"));
await page.waitForTimeout(2500); // let map tiles load before the timeline starts

const interval = 1000 / FPS;
let i = 0;
const started = Date.now();

while (Date.now() - started < MAX_SECONDS * 1000) {
  const t0 = Date.now();
  // JPEG rather than PNG: ~18ms vs ~204ms per frame, which is the difference
  // between capturing at a true 12fps and silently sampling at 3fps.
  await page.screenshot({
    path: path.join(frames, `f${String(i).padStart(4, "0")}.jpg`),
    type: "jpeg", quality: 92
  });
  i++;

  if (await page.evaluate(() => window.__demoDone === true)) break;

  const spent = Date.now() - t0;
  if (spent < interval) await page.waitForTimeout(interval - spent);
}

await browser.close();
const wall = (Date.now() - started) / 1000;
console.log(`captured ${i} frames -> ${(i / FPS).toFixed(1)}s of video in ${wall.toFixed(1)}s wall clock`);
if (Math.abs(wall - i / FPS) > 1.5) {
  console.warn("WARNING: capture drifted from real time — playback speed will be wrong");
}

const gif = path.join(dir, "demo.gif");
const mp4 = path.join(dir, "demo.mp4");
const palette = path.join(frames, "palette.png");
const input = path.join(frames, "f%04d.jpg");

// MP4 first — this is what the Chrome Web Store's video slot (YouTube) wants
execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", input,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=1280:800", "-crf", "20", mp4],
  { stdio: "inherit" });

// GIF for README / Reddit / Product Hunt, where animation actually renders
const scale = "scale=900:-1:flags=lanczos";
execFileSync("ffmpeg", ["-y", "-i", input, "-vf", `${scale},palettegen=max_colors=200:stats_mode=diff`, "-update", "1", "-frames:v", "1", palette],
  { stdio: "inherit" });
execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", input, "-i", palette,
  "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
  "-loop", "0", gif], { stdio: "inherit" });

for (const f of [gif, mp4]) {
  console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`);
}

fs.rmSync(frames, { recursive: true, force: true });
