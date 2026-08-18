// Map panel features: new-since-last-visit, the draw-an-area lasso, the
// scraper-health banner, and tooltip fit inside the 420px panel.
import { launch, openMap, sendListings, listingsFrom, makeChecker } from "./lib.mjs";

const { check, state } = makeChecker();
const browser = await launch();

const visiblePins = page => page.evaluate(() =>
  [...document.querySelectorAll(".leaflet-marker-icon")].filter(e => e.offsetParent !== null).length);

const BASE = ["Oslo", "Oslo", "Bergen", "Trondheim"];

console.log("=== Rendering ===");
const page = await openMap(browser, { onError: e => check("no page errors", false, e.message) });
await sendListings(page, listingsFrom(BASE));
await page.waitForTimeout(1500);
check("listings render as pins", await page.evaluate(() => document.querySelectorAll(".mkp-pin").length) >= 3);

console.log("\n=== New since last visit ===");
{
  check("first ever run marks nothing new",
    await page.evaluate(() => document.getElementById("mkp-tool-new").dataset.count) === "0");

  // Come back tomorrow: history is kept, the "since" line moves back
  await page.evaluate(() => {
    localStorage.setItem("mkpm-last-visit", String(Date.now() - 24 * 3600 * 1000));
    localStorage.removeItem("mkpm-visit-anchor");
  });
  await page.reload();
  await page.waitForTimeout(3000);

  await sendListings(page, listingsFrom(BASE));
  await page.waitForTimeout(800);
  check("already-seen listings are not new",
    await page.evaluate(() => document.getElementById("mkp-tool-new").dataset.count) === "0");

  const fresh = listingsFrom(BASE).concat({
    title: "New bike", location: "Oslo", price: "3 000 kr", badge: "",
    url: "https://www.facebook.com/marketplace/item/424242/", image: "img-new.jpg"
  });
  await sendListings(page, fresh);
  await page.waitForTimeout(800);

  check("a genuinely new listing is counted",
    await page.evaluate(() => document.getElementById("mkp-tool-new").dataset.count) === "1");
  check("its pin gets the marker ring",
    await page.evaluate(() => document.querySelectorAll(".mkp-pin-new").length) === 1);

  await page.click("#mkp-tool-new");
  await page.waitForTimeout(400);
  check("filter shows only the new one", await visiblePins(page) === 1, `${await visiblePins(page)} visible`);

  await page.click("#mkp-tool-new");
  await page.waitForTimeout(400);
  check("un-toggling restores all pins", await visiblePins(page) === 5, `${await visiblePins(page)} visible`);
}

console.log("\n=== Draw-an-area filter ===");
{
  const before = await visiblePins(page);

  await page.click("#mkp-tool-area");
  await page.waitForTimeout(200);
  check("draw mode arms", await page.evaluate(() =>
    document.getElementById("mkp-mapper-map").classList.contains("mkp-drawing")));

  const target = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".leaflet-marker-icon")].find(e => e.offsetParent !== null);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  // Trace the square exactly once. A doubly-wound ring reads as "outside"
  // under even-odd, which is correct behaviour rather than a bug to test around.
  const box = 26;
  await page.mouse.move(target.x - box, target.y - box);
  await page.mouse.down();
  await page.mouse.move(target.x + box, target.y - box, { steps: 8 });
  await page.mouse.move(target.x + box, target.y + box, { steps: 8 });
  await page.mouse.move(target.x - box, target.y + box, { steps: 8 });
  await page.mouse.move(target.x - box, target.y - box, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const after = await visiblePins(page);
  check("lasso narrows the results", after < before && after >= 1, `${before} -> ${after}`);
  check("polygon drawn", await page.evaluate(() => !!document.querySelector(".leaflet-overlay-pane path")));
  check("hint reports the count", await page.evaluate(() =>
    /listing/.test(document.getElementById("mkp-area-hint").textContent)));

  await page.click("#mkp-tool-area");
  await page.waitForTimeout(400);
  check("clearing restores all pins", await visiblePins(page) === before);
  check("polygon removed", await page.evaluate(() => !document.querySelector(".leaflet-overlay-pane path")));
}

console.log("\n=== Silent-failure banner ===");
{
  await page.evaluate(() => window.postMessage(
    { source: "marketplace-mapper", type: "scrape-health", status: "no-listings" }, "*"));
  await page.waitForTimeout(300);
  check("banner shows", await page.evaluate(() =>
    getComputedStyle(document.getElementById("mkp-health")).display !== "none"));
  check("offers a report link", await page.evaluate(() =>
    !!document.querySelector("#mkp-health a[href^='mailto:']")));

  await page.evaluate(() => window.postMessage(
    { source: "marketplace-mapper", type: "scrape-health", status: "ok" }, "*"));
  await page.waitForTimeout(300);
  check("banner hides when healthy", await page.evaluate(() =>
    document.getElementById("mkp-health").style.display === "none"));
}

console.log("\n=== Tooltips fit the panel ===");
{
  const clipped = await page.evaluate(() => {
    const panel = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll("#mkp-mapper-tools [data-tooltip]").forEach(el => {
      const r = el.getBoundingClientRect();
      const ruler = document.createElement("div");
      Object.assign(ruler.style, {
        position: "absolute", visibility: "hidden", top: "-9999px", fontSize: ".68rem",
        lineHeight: "1.3", padding: "4px 8px", width: "max-content", maxWidth: "190px",
        whiteSpace: "normal"
      });
      ruler.textContent = el.dataset.tooltip;
      document.body.appendChild(ruler);
      const w = ruler.getBoundingClientRect().width;
      ruler.remove();
      const left = el.classList.contains("tt-right") ? r.right - w
        : el.classList.contains("tt-left") ? r.left
          : r.left + r.width / 2 - w / 2;
      if (left < 0 || left + w > panel) bad.push(el.id);
    });
    return bad;
  });
  check("no tooltip clips at 420px", clipped.length === 0, clipped.join(", "));
}

await page.close();
await browser.close();
console.log(state.fail ? `\n${state.fail} FAILURE(S)` : `\nAll ${state.pass} checks passed`);
process.exit(state.fail ? 1 : 0);
