// content.js scraping: the results grid, item pages (including after a
// hypothetical Facebook redesign), which image gets picked, and the
// silent-failure detector.
import { launch, contentScript, CONTENT_HARNESS, makeChecker } from "./lib.mjs";

const { check, state } = makeChecker();
const contentJs = contentScript();
const browser = await launch();

const card = (id, price, title, loc) => `
  <a href="/marketplace/item/${id}/" aria-label="${title}, ${price}, ${loc}, listing 1">
    <img src="https://scontent.fbcdn.net/${id}.jpg">
    <div><span>${price}</span></div><div><span>${title}</span></div><div><span>${loc}</span></div>
  </a>`;

const filler = (n = 20) => `<div>${"Marketplace page with plenty of chrome text. ".repeat(n)}</div>`;

const ITEM_CURRENT = `<!doctype html><html><head>
  <meta property="og:image" content="https://scontent.fbcdn.net/hero.jpg">
  </head><body>
  <div aria-hidden="false">chrome one</div>
  <div aria-hidden="false">chrome two</div>
  <div aria-hidden="false">1 500 kr</div>
  ${Array.from({ length: 6 }, (_, i) => `<div aria-hidden="false">filler ${i}</div>`).join("")}
  <div aria-hidden="false"><span>Oslo, Norway</span></div>
  <h1>Vintage oak desk</h1>
  <img src="https://scontent.fbcdn.net/hero.jpg" width="800" height="600">
  <p>Listed 2 days ago</p>
  </body></html>`;

// No aria-hidden scaffolding and different nesting: the original positional
// scraper (img[1], spans[2], spans[9]) returns nothing at all here.
const ITEM_REDESIGNED = `<!doctype html><html><head>
  <meta property="og:image" content="https://scontent.fbcdn.net/hero2.jpg">
  <meta property="og:title" content="Vintage oak desk | Facebook Marketplace">
  </head><body>
  <main><section><h1>Vintage oak desk</h1>
    <div><div><span>1 500 kr</span></div></div>
    <div><span>Listed 2 days ago</span></div>
    <div><span>Oslo, Norway</span></div>
  </section></main>
  <img src="https://scontent.fbcdn.net/hero2.jpg" width="800" height="600">
  </body></html>`;

const RESULTS_OK = `<!doctype html><html><body>${filler()}
  ${card(1, "1 500 kr", "Oak desk", "Oslo")}
  ${card(2, "Free", "Old sofa", "Bergen")}
  ${card(3, "250 kr", "Lamp", "Oslo")}</body></html>`;

const RESULTS_BROKEN = `<!doctype html><html><body>${filler()}</body></html>`;

const RESULTS_UNPARSED = `<!doctype html><html><body>${filler()}
  ${[1, 2, 3].map(i => `<a href="/marketplace/item/${i}/"><img src="x.jpg"></a>`).join("")}
  </body></html>`;

async function run(url, html, { ticks = 1 } = {}) {
  const page = await browser.newPage();
  await page.route("**/*", r =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  await page.addInitScript(CONTENT_HARNESS);

  await page.goto(url);
  await page.evaluate(contentJs);
  await page.waitForTimeout(2100 * ticks + 400);

  const msgs = await page.evaluate(() => window.__msgs);
  await page.close();
  return msgs;
}

const itemFrom = (msgs, id) =>
  msgs.filter(m => m.listings).at(-1)?.listings.find(l => l.url.includes(`/item/${id}`));

console.log("=== Item page: current layout ===");
{
  const item = itemFrom(await run("https://www.facebook.com/marketplace/item/1/", ITEM_CURRENT), 1);
  check("item scraped", !!item, JSON.stringify(item));
  check("price", item?.price?.includes("1 500"));
  check("location", item?.location === "Oslo, Norway");
  check("title", item?.title === "Vintage oak desk");
  check("image", !!item?.image);
}

console.log("\n=== Item page: after a Facebook redesign ===");
{
  const item = itemFrom(await run("https://www.facebook.com/marketplace/item/1/", ITEM_REDESIGNED), 1);
  check("still scrapes", !!item, JSON.stringify(item));
  check("price via leaf scan", item?.price?.includes("1 500"));
  check("location via shape match", item?.location === "Oslo, Norway");
  check("image found", item?.image?.includes("hero2"));

  const old = await (async () => {
    const p = await browser.newPage();
    await p.route("**/*", r => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: ITEM_REDESIGNED }));
    await p.goto("https://www.facebook.com/marketplace/item/1/");
    const out = await p.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('div[aria-hidden=false]'));
      return { price: spans[2]?.textContent ?? null, loc: spans[9]?.querySelector('span')?.textContent ?? null };
    });
    await p.close();
    return out;
  })();
  check("(the old positional scraper would have failed here)",
    old.price === null && old.loc === null, JSON.stringify(old));
}

console.log("\n=== Results grid ===");
{
  const msgs = await run("https://www.facebook.com/marketplace/oslo/search", RESULTS_OK);
  const last = msgs.filter(m => m.listings).at(-1);
  check("listings scraped", last?.listings.length === 3, `got ${last?.listings.length}`);
  check("location parsed", last?.listings[0].location === "Oslo");
  const health = msgs.filter(m => m.type === "scrape-health").at(-1);
  check("healthy grid raises no alarm", !health || health.status === "ok", JSON.stringify(health));
}

console.log("\n=== Silent-failure detector ===");
{
  const msgs = await run("https://www.facebook.com/marketplace/oslo/search", RESULTS_BROKEN, { ticks: 9 });
  check("fires when no listings are found",
    msgs.filter(m => m.type === "scrape-health").at(-1)?.status === "no-listings");
}
{
  const msgs = await run("https://www.facebook.com/marketplace/oslo/search", RESULTS_UNPARSED, { ticks: 9 });
  check("fires when cards can't be parsed",
    msgs.filter(m => m.type === "scrape-health").at(-1)?.status === "unparsed");
}
{
  const msgs = await run("https://www.facebook.com/marketplace/oslo/search", RESULTS_BROKEN, { ticks: 2 });
  const health = msgs.filter(m => m.type === "scrape-health").at(-1);
  check("stays quiet during the grace period", !health || health.status === "ok", JSON.stringify(health));
}

await browser.close();
console.log(state.fail ? `\n${state.fail} FAILURE(S)` : `\nAll ${state.pass} checks passed`);
process.exit(state.fail ? 1 : 0);
