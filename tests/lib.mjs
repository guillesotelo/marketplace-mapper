// Shared plumbing for the regression suites.
//
// These tests drive the real extension files in a real Chromium — no mocks of
// our own code — because every bug they cover came from browser behaviour
// (isolated worlds, Leaflet's transforms, SPA-stale meta tags) that a unit test
// with a fake DOM would have happily reported as working.
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXT = path.join(ROOT, "extension");

// A Chromium from a playwright install, or whatever CHROME_PATH points at.
export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const cache = path.join(process.env.HOME, "Library/Caches/ms-playwright");
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).filter(d => d.startsWith("chromium-")).sort().reverse()) {
      const macDir = path.join(cache, dir, "chrome-mac-arm64");
      if (!fs.existsSync(macDir)) continue;
      for (const app of fs.readdirSync(macDir).filter(a => a.endsWith(".app"))) {
        const exe = path.join(macDir, app, "Contents/MacOS", app.replace(/\.app$/, ""));
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  throw new Error("No Chromium found. Set CHROME_PATH=/path/to/chrome");
}

export function makeChecker() {
  const state = { pass: 0, fail: 0 };
  const check = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    cond ? state.pass++ : state.fail++;
  };
  return { check, state };
}

export async function launch(opts = {}) {
  return chromium.launch({ executablePath: chromePath(), ...opts });
}

// Serve extension/ over http so map.html loads its real leaflet + city DB.
export async function serveExtension(page) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());

    if (/tile|basemaps|openstreetmap/.test(url.hostname)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
    }

    const file = path.join(EXT, url.pathname === "/" ? "map.html" : url.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = {
        ".html": "text/html; charset=utf-8", ".js": "text/javascript",
        ".css": "text/css", ".gz": "application/gzip", ".png": "image/png"
      }[path.extname(file)] || "application/octet-stream";
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
}

// A loaded map panel, ready to receive the messages content.js would send.
export async function openMap(browser, { onError } = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 520 } });
  if (onError) page.on("pageerror", onError);

  await serveExtension(page);
  await page.addInitScript(() => {
    window.chrome = { runtime: { getURL: p => "/" + p } };
    // addInitScript re-runs on reload; only wipe storage on the first load
    if (!sessionStorage.getItem("mkpm-test-booted")) {
      localStorage.clear();
      sessionStorage.setItem("mkpm-test-booted", "1");
    }
  });

  await page.goto("http://localhost/map.html");
  await page.waitForTimeout(3000);   // the city database is ~11MB
  return page;
}

// Mimic one scrape tick from content.js
export function sendListings(page, listings, extra = {}) {
  return page.evaluate(({ listings, extra }) => window.postMessage({
    source: "marketplace-mapper",
    listings,
    url: "https://www.facebook.com/marketplace/x/search",
    context: { lat: null, lon: null, country: null, admin1: null },
    city: null,
    itemScraped: false,
    ...extra
  }, "*"), { listings, extra });
}

export const listingsFrom = (locations) => locations.map((loc, i) => ({
  title: `Item ${i}`,
  location: loc,
  price: `${100 + i} kr`,
  badge: "",
  url: `https://www.facebook.com/marketplace/item/${9000 + i}/`,
  image: `img-${i}.jpg`   // mergeListings dedupes on image URL
}));

// Stand in for the map iframe so content.js posts where we can read it
export const CONTENT_HARNESS = () => {
  window.__msgs = [];
  window.chrome = { runtime: { getURL: () => "about:blank" } };
  document.addEventListener("DOMContentLoaded", () => {
    if (document.getElementById("mkp-mapper-frame")) return;
    const fake = document.createElement("div");
    fake.id = "mkp-mapper-frame";
    fake.contentWindow = { postMessage: m => window.__msgs.push(m) };
    fake.style.display = "none";
    document.body.appendChild(fake);
  });
};

export const contentScript = () => fs.readFileSync(path.join(EXT, "content.js"), "utf8");
