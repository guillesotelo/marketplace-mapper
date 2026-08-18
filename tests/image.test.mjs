// Which photo ends up on the map for an item page.
//
// Covers a report where the popup showed a sidebar ad instead of the listing.
// Two traps are encoded here deliberately:
//   1. og:image is stale after in-app navigation (Marketplace is an SPA), so it
//      described a completely different page.
//   2. Ad creatives are often LARGER files than the listing photo while being
//      rendered as small thumbnails, which defeats "largest intrinsic size".
import { launch, contentScript, CONTENT_HARNESS, makeChecker } from "./lib.mjs";

const { check, state } = makeChecker();
const contentJs = contentScript();
const browser = await launch();

const svg = (w, h, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
  `<rect width="${w}" height="${h}" fill="#ccc"/><text x="10" y="40">${label}</text></svg>`;

const ASSETS = {
  "/hero.jpg":   svg(900, 1100, "listing"),
  "/ad-big.jpg": svg(1600, 1200, "ad"),      // bigger file than the listing photo
  "/ad2.jpg":    svg(1400, 1000, "ad2"),
  "/avatar.jpg": svg(60, 60, "avatar"),
  "/stale.jpg":  svg(1200, 1200, "stale-og"),
};

const ITEM_PAGE = `<!doctype html><html><head>
  <meta property="og:image" content="https://scontent.fbcdn.net/stale.jpg">
  <style>
    body { margin:0 }
    .hero { width: 790px; height: 970px; }
    .rail { position: absolute; top: 0; right: 0; width: 420px; }
    .adthumb { width: 160px; height: 160px; }
    .avatar { width: 40px; height: 40px; }
  </style></head><body>
  <div><img class="hero" src="https://scontent.fbcdn.net/hero.jpg"></div>
  <div class="rail">
    <h1>4st 2.5 SATA Hårddiskar</h1>
    <div><span>500 kr</span></div>
    <div><span>Listed 22 hours ago</span></div>
    <div><span>Malmö, M</span></div>
    <h2>Ads</h2>
    <a href="https://example.com/ad"><img class="adthumb" src="https://scontent.fbcdn.net/ad-big.jpg"></a>
    <a href="https://example.com/ad2"><img class="adthumb" src="https://scontent.fbcdn.net/ad2.jpg"></a>
    <h2>Seller information</h2>
    <img class="avatar" src="https://scontent.fbcdn.net/avatar.jpg">
  </div></body></html>`;

const GRID_PAGE = `<!doctype html><html><body>
  <div>${"Marketplace results page with plenty of chrome text. ".repeat(20)}</div>
  <a href="/marketplace/item/777/" aria-label="4st 2.5 SATA Hårddiskar, 500 kr, Malmö, listing 1">
    <img src="https://scontent.fbcdn.net/card-777.jpg">
    <div><span>500 kr</span></div><div><span>4st 2.5 SATA Hårddiskar</span></div><div><span>Malmö</span></div>
  </a></body></html>`;

async function scrapeItem({ viaGrid }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  await page.route("**/*", route => {
    const u = new URL(route.request().url());
    if (ASSETS[u.pathname]) {
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: ASSETS[u.pathname] });
    }
    if (u.pathname.startsWith("/card-")) {
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg(300, 300, "card") });
    }
    return route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8",
      body: u.pathname.includes("/item/") ? ITEM_PAGE : GRID_PAGE
    });
  });
  await page.addInitScript(CONTENT_HARNESS);

  if (viaGrid) {
    await page.goto("https://www.facebook.com/marketplace/malmo/search");
    await page.evaluate(contentJs);
    await page.waitForTimeout(2400);
    await page.evaluate(() => history.pushState({}, "", "/marketplace/item/777/"));
    await page.setContent(ITEM_PAGE);
    await page.waitForTimeout(2600);
  } else {
    await page.goto("https://www.facebook.com/marketplace/item/777/");
    await page.evaluate(contentJs);
    await page.waitForTimeout(2600);
  }

  const msgs = await page.evaluate(() => window.__msgs);
  await page.close();
  return msgs.filter(m => m.listings).at(-1)?.listings.find(l => l.url.includes("/item/777"));
}

console.log("=== Landing directly on an item page ===");
{
  const item = await scrapeItem({ viaGrid: false });
  check("item scraped", !!item, item?.image);
  check("picks the listing photo, not an ad", item?.image?.includes("hero"), item?.image);
  check("ignores the stale og:image", !item?.image?.includes("stale"), item?.image);
  check("title intact", item?.title === "4st 2.5 SATA Hårddiskar", item?.title);
  check("price intact", item?.price === "500 kr", item?.price);
}

console.log("\n=== Arriving from the results grid ===");
{
  const item = await scrapeItem({ viaGrid: true });
  check("item scraped", !!item, item?.image);
  check("reuses the card image we already had", item?.image?.includes("card-777"), item?.image);
  check("location reused from the grid", item?.location === "Malmö", item?.location);
}

await browser.close();
console.log(state.fail ? `\n${state.fail} FAILURE(S)` : `\nAll ${state.pass} checks passed`);
process.exit(state.fail ? 1 : 0);
