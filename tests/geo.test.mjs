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

console.log("\n=== Region text the resolver has to cope with ===");
{
  const page = await openMap(browser);

  // "New York, Norfolk, United Kingdom" was reported as resolving to nothing:
  // that hamlet isn't in the database and neither is Norfolk as a UK place, so
  // the country is the only usable signal in the string.
  const cases = [
    // The hamlet isn't in the database, but the county is — so this resolves
    // to Norfolk rather than falling all the way back to "United Kingdom"
    ["New York, Norfolk, United Kingdom", "GB", false],
    ["Norfolk, United Kingdom", "GB", false],
    ["Kent, England", "GB", false],
    ["United Kingdom", "GB", true],
    ["Canada", "CA", true],
    ["London, England", "GB", false],
    ["Norwich, England", "GB", false],
    ["Montreal, QC", "CA", false],
    ["Austin, TX", "US", false],
    ["Malmo, Skane", "SE", false],
  ];

  for (const [text, country, coarse] of cases) {
    const r = await page.evaluate(t => {
      const x = resolveHomeText(t);
      return x && { country: x.country, coarse: !!x.coarse, label: x.label };
    }, text);
    check(`"${text}" -> ${country}`, r?.country === country, JSON.stringify(r));
    if (coarse) check(`"${text}" falls back to country level`, r?.coarse === true);
  }

  check("nonsense still reports not found",
    await page.evaluate(() => resolveHomeText("qwertyville") === null));

  // Counties come from the admin2 data added to the database
  const norfolk = await page.evaluate(() => resolveHomeText("New York, Norfolk, United Kingdom"));
  check("resolves the county, not just the country", norfolk?.admin2 === "Norfolk", JSON.stringify(norfolk?.label));
  check("and lands in East Anglia",
    Math.abs(norfolk.lat - 52.7) < 1 && Math.abs(norfolk.lon - 1.1) < 1,
    `${norfolk?.lat?.toFixed(2)}, ${norfolk?.lon?.toFixed(2)}`);

  // Population breaks ties between namesakes that nothing else can separate
  const prominence = await page.evaluate(() => ({
    montreal: geocodeOffline("Montreal", null),
    laval: geocodeOffline("Laval", null),
    london: geocodeOffline("London", null),
  }));
  check("bare 'Montreal' picks the big one", prominence.montreal?.country === "CA",
    `${prominence.montreal?.name} ${prominence.montreal?.country} pop=${prominence.montreal?.population}`);
  check("bare 'London' picks the big one", prominence.london?.country === "GB",
    `${prominence.london?.name} ${prominence.london?.country} pop=${prominence.london?.population}`);
  check("every candidate now carries a population",
    await page.evaluate(() => cityList.filter(c => typeof c.population !== "number").length === 0));

  // A country-only region must still steer the geocoder
  await page.evaluate(() => {
    saveHomeContext(resolveHomeText("United Kingdom"));
    resetGeocoding();
  });
  await sendListings(page, listingsFrom(["Norwich", "Cambridge", "Bristol", "York", "Reading"]));
  await page.waitForTimeout(1500);
  const { pins } = await readPins(page);
  const inUk = pins.filter(p => p.lat > 49 && p.lat < 61 && p.lon > -9 && p.lon < 2);
  check("country-only region places listings in the UK",
    pins.length > 0 && inUk.length === pins.length, `${inUk.length}/${pins.length}`);

  await page.close();
}

console.log("\n=== Region readings ===");
{
  const page = await openMap(browser);
  // Each of these has burned us or is one comma away from doing so
  const CASES = [
    ["Palermo, New York",     "US", "New York"],       // town absent from the DB
    ["Palermo, Italy",        "IT", "Sicily"],
    ["Palermo",               "IT", "Sicily"],
    ["Los Angeles, CA",       "US", "California"],     // CA is also Canada
    ["Wilmington, DE",        "US", "Delaware"],       // DE is also Germany
    ["London, ON",            "CA", "Ontario"],
    ["London, England",       "GB", "England"],
    ["Springfield, Illinois", "US", "Illinois"],
    ["Brooklyn, New York",    "US", "New York"],
    ["Toronto, Ontario",      "CA", "Ontario"],
    ["Montreal, QC",          "CA", "Quebec"],
    ["Montreal, Quebec",      "CA", "Quebec"],
    ["Austin, TX",            "US", "Texas"],
    ["Malmo, Skane",          "SE", "Skåne"],
    ["Malmo, M",              "SE", "Skåne"],          // M is also Munster, IE
    ["Canada",                "CA", null],             // must not match "La Cañada"
    ["United Kingdom",        "GB", null],
  ];

  for (const [text, country, admin1] of CASES) {
    const r = await page.evaluate(t => {
      const x = resolveHomeText(t);
      return x && { country: x.country, admin1: x.admin1, label: x.label };
    }, text);
    const ok = r?.country === country && (admin1 === null || r?.admin1 === admin1);
    check(`"${text}" -> ${country}${admin1 ? "/" + admin1 : ""}`, ok, JSON.stringify(r?.label));
  }

  check("nonsense is still reported as not found",
    await page.evaluate(() => resolveHomeText("qwertyville, nowhere") === null));

  await page.close();
}

console.log("\n=== An empty map explains itself ===");
{
  const page = await openMap(browser);

  // Pin a region that cannot match these listings, the way a mistyped or
  // unresolvable place would
  await page.evaluate(() => { saveHomeContext(resolveHomeText("Palermo, Italy")); resetGeocoding(); });
  await sendListings(page, listingsFrom(["Austin, TX", "Houston, TX", "Dallas, TX"]));
  await page.waitForTimeout(1500);

  const pins = await page.evaluate(() => markers.length);
  check("mismatched region does empty the map", pins === 0, `${pins} pins`);
  check("but the map says why", await page.evaluate(() =>
    getComputedStyle(document.getElementById("mkp-region-warn")).display !== "none"));
  check("and names the region", await page.evaluate(() =>
    /Palermo/.test(document.getElementById("mkp-region-warn").textContent)));

  await page.click("#mkp-region-reset");
  await page.waitForTimeout(300);
  check("one click clears the region", await page.evaluate(() => homeContext === null));

  await sendListings(page, listingsFrom(["Austin, TX", "Houston, TX", "Dallas, TX"]));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => markers.length);
  check("listings come back afterwards", after === 3, `${after} pins`);

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
