// Geocoding: which country a search resolves to, and the manual region override.
//
// Covers a user report from Aug 2026: a Montreal user's listings were all
// plotted in southern France. Quebec city names (Laval, Verdun, Montréal,
// Mirabel…) each match several French communes, and the old inference counted
// raw candidate cities, so France outvoted Canada.
import { launch, openMap, sendListings, listingsFrom, makeChecker } from "./lib.mjs";

const { check, state } = makeChecker();
const browser = await launch();

const readPins = page => page.evaluate(() => ({
  ctx: typeof searchContext !== "undefined" ? searchContext : null,
  pins: markers.map(m => ({
    loc: m.listing.location,
    lat: m.getLatLng().lat,
    lon: m.getLatLng().lng
  }))
}));

// [name, listing locations, expected country, [latMin, latMax, lonMin, lonMax]]
const REGIONS = [
  ["Quebec", ["Montreal, QC", "Laval, QC", "Verdun, QC", "Longueuil, QC", "Mirabel, QC",
    "Brossard, QC", "Terrebonne, QC", "Granby, QC", "Repentigny, QC", "Blainville, QC",
    "Boucherville, QC", "Saint-Jerome, QC"], "CA", [44, 54, -80, -56]],

  ["France", ["Paris", "Lyon", "Marseille", "Toulouse", "Nantes", "Bordeaux",
    "Montpellier", "Rennes", "Laval", "Verdun", "Montreal", "Mirabel"], "FR", [41, 51.5, -5.5, 9.8]],

  // "M" (Skåne) is a code we can't interpret — candidates must stay neutral
  ["Sweden", ["Malmo, M", "Lund, M", "Helsingborg, M", "Landskrona, M", "Trelleborg, M",
    "Ystad, M", "Kristianstad, M", "Hassleholm, M", "Eslov, M", "Angelholm, M"],
    "SE", [55, 60, 10, 20]],

  ["Texas", ["Austin, TX", "Houston, TX", "Dallas, TX", "Plano, TX", "Irving, TX",
    "Frisco, TX", "Katy, TX", "Allen, TX", "Denton, TX", "Waco, TX"], "US", [25, 37, -107, -93]],

  // "ON" and "IN" are stop-words in normalize(); region codes must survive it
  ["Ontario", ["Toronto, ON", "Ottawa, ON", "Hamilton, ON", "London, ON", "Windsor, ON",
    "Kingston, ON", "Barrie, ON", "Guelph, ON", "Oshawa, ON", "Waterloo, ON"],
    "CA", [41, 57, -96, -74]],

  ["Indiana", ["Indianapolis, IN", "Fort Wayne, IN", "Evansville, IN", "Carmel, IN",
    "Fishers, IN", "Bloomington, IN", "Muncie, IN", "Kokomo, IN", "Anderson, IN",
    "Elkhart, IN"], "US", [37, 42, -89, -84]],
];

for (const [name, locs, wantCountry, [latMin, latMax, lonMin, lonMax]] of REGIONS) {
  console.log(`\n=== ${name} ===`);
  const page = await openMap(browser, { onError: e => check(`${name}: no page errors`, false, e.message) });

  await sendListings(page, listingsFrom(locs));
  await page.waitForTimeout(1500);

  const { ctx, pins } = await readPins(page);
  const stray = pins.filter(p =>
    !(p.lat > latMin && p.lat < latMax && p.lon > lonMin && p.lon < lonMax));

  console.log(`  context: ${ctx ? ctx.country + "/" + ctx.admin1 : "none"}   pins: ${pins.length}/${locs.length}`);
  for (const s of stray) console.log(`   stray: ${s.loc} -> ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`);

  check(`${name}: infers ${wantCountry}`, ctx?.country === wantCountry, `got ${ctx?.country}`);
  check(`${name}: keeps every listing`, pins.length === locs.length, `${pins.length}/${locs.length}`);
  check(`${name}: every pin in region`, stray.length === 0, `${stray.length} stray`);

  await page.close();
}

console.log("\n=== Manual region override ===");
{
  const page = await openMap(browser);

  // Bare ambiguous names, no admin hint at all: the worst case for auto-detect
  const ambiguous = ["Montreal", "Laval", "Verdun", "Granby", "Mirabel"];
  await sendListings(page, listingsFrom(ambiguous));
  await page.waitForTimeout(1200);

  await page.click("#mkp-tool-home");
  await page.fill("#mkp-home-input", "Montreal, QC");
  await page.click("#mkp-home-apply");
  await page.waitForTimeout(600);

  const status = await page.textContent("#mkp-home-status");
  check("resolves and reports the chosen region", /Quebec|CA/.test(status), status);
  check("tool shows as active", await page.evaluate(() =>
    document.getElementById("mkp-tool-home").classList.contains("active")));

  await sendListings(page, listingsFrom(ambiguous));
  await page.waitForTimeout(1200);

  const { pins } = await readPins(page);
  const inQc = pins.filter(p => p.lat > 44 && p.lat < 54 && p.lon > -80 && p.lon < -56);
  check("override forces listings into Quebec", pins.length > 0 && inQc.length === pins.length,
    `${inQc.length}/${pins.length}`);

  await page.reload();
  await page.waitForTimeout(3000);
  check("override survives a reload", await page.evaluate(() =>
    !!homeContext && homeContext.country === "CA"));

  await page.click("#mkp-tool-home");
  await page.click("#mkp-home-clear");
  await page.waitForTimeout(400);
  check("Auto clears the override", await page.evaluate(() => homeContext === null));

  await page.close();
}

console.log("\n=== Late region fix ===");
{
  // Listings that arrive before the region is known must be moved once it is,
  // not left on whichever namesake the database happened to list first.
  const page = await openMap(browser);
  await sendListings(page, listingsFrom(["Toronto, ON", "Ottawa, ON", "Hamilton, ON"]));
  await page.waitForTimeout(1000);
  const early = await readPins(page);

  await sendListings(page, listingsFrom([
    "Toronto, ON", "Ottawa, ON", "Hamilton, ON", "London, ON", "Windsor, ON",
    "Kingston, ON", "Barrie, ON", "Guelph, ON", "Oshawa, ON", "Waterloo, ON",
    "Cambridge, ON", "Markham, ON"
  ]));
  await page.waitForTimeout(1500);

  const late = await readPins(page);
  const strays = late.pins.filter(p => !(p.lat > 41 && p.lat < 57 && p.lon > -96 && p.lon < -74));
  console.log(`  first batch placed ${early.pins.length}, final ${late.pins.length}`);
  check("early listings are repositioned once the region is known", strays.length === 0,
    `${strays.length} stray`);

  await page.close();
}

await browser.close();
console.log(state.fail ? `\n${state.fail} FAILURE(S)` : `\nAll ${state.pass} checks passed`);
process.exit(state.fail ? 1 : 0);
