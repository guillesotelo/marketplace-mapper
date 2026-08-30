// -----------------------------
// Basemap
//
// CARTO began requiring an API key for raster tiles in August 2026; unkeyed
// requests still render but come back stamped "API KEY REQUIRED". A key is free
// (5 million tiles/month, non-commercial) from https://carto.com/basemaps/apikey/
//
// Paste the key below. If CARTO's mail gives a full tile URL, put that in `url`
// instead and leave `key` empty — the parameter name has changed before, so the
// URL they send you is the authoritative version.
// -----------------------------
const BASEMAP = {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    // Set by basemap-key.js, which scripts/set-basemap-key.js generates and git
    // ignores. Absent (a fresh clone) just means watermarked tiles.
    key: typeof MKPM_BASEMAP_KEY === "string" ? MKPM_BASEMAP_KEY : "",
    keyParam: "key",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
};

function basemapUrl() {
    if (!BASEMAP.key) return BASEMAP.url;
    const sep = BASEMAP.url.includes("?") ? "&" : "?";
    return `${BASEMAP.url}${sep}${BASEMAP.keyParam}=${encodeURIComponent(BASEMAP.key)}`;
}

let map;
let pendingListings = null;   // arrived before the city database was ready
let markerLayerGroup = null;
let markers = [];
let markerByItemKey = new Map(); // itemKey -> marker
let cityIndex = null;
let cityList = null;   // raw rows, for country/region centroids
let lockedAdmin1 = null; // soft lock for inferring listings within the same admin1 first

let addedItems = new Set();         // Image URLs of markers already added
let globalListings = [];            // merged listings
let lastSearchSignature = null;     // for new-search detection
let initialLocationSet = null;
let jitterCache = new Map();   // url -> { jLat, jLon }

let searchContext = null;
let contextSamples = [];
let lastIncomingContext = null;

// Listings sampled before guessing a region. Counted in listings, not in
// candidate cities — see collectContextSample.
const CONTEXT_SAMPLE_LIMIT = 10;

// A region the user pinned by hand. Overrides every other signal, which is the
// only reliable answer for places whose city names collide with somewhere else
// in the world (Quebec vs France being the reported case).
let homeContext = loadHomeContext();

function loadHomeContext() {
    try {
        const raw = JSON.parse(localStorage.getItem("mkpm-home") || "null");
        return raw && typeof raw.lat === "number" ? raw : null;
    } catch {
        return null;
    }
}

function saveHomeContext(ctx) {
    homeContext = ctx;
    if (ctx) localStorage.setItem("mkpm-home", JSON.stringify(ctx));
    else localStorage.removeItem("mkpm-home");
}

// Country names people actually type, mapped to the ISO codes the database
// uses. Without this, "New York, Norfolk, United Kingdom" had nothing to match:
// that hamlet isn't in the database, and neither is Norfolk as a UK place, so
// the only usable signal in the string was the country.
const COUNTRY_NAMES = {
    "united kingdom": "GB", uk: "GB", "great britain": "GB", britain: "GB",
    england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB",
    "united states": "US", "united states of america": "US", usa: "US", america: "US",
    canada: "CA", australia: "AU", "new zealand": "NZ", ireland: "IE",
    france: "FR", germany: "DE", deutschland: "DE", spain: "ES", espana: "ES",
    italy: "IT", italia: "IT", portugal: "PT", netherlands: "NL", holland: "NL",
    belgium: "BE", luxembourg: "LU", switzerland: "CH", austria: "AT",
    denmark: "DK", danmark: "DK", sweden: "SE", sverige: "SE", norway: "NO",
    norge: "NO", finland: "FI", suomi: "FI", iceland: "IS",
    poland: "PL", polska: "PL", "czech republic": "CZ", czechia: "CZ",
    slovakia: "SK", hungary: "HU", romania: "RO", bulgaria: "BG", greece: "GR",
    croatia: "HR", slovenia: "SI", serbia: "RS", ukraine: "UA", estonia: "EE",
    latvia: "LV", lithuania: "LT",
    mexico: "MX", brazil: "BR", brasil: "BR", argentina: "AR", chile: "CL",
    colombia: "CO", peru: "PE", uruguay: "UY", paraguay: "PY", ecuador: "EC",
    "costa rica": "CR", panama: "PA", guatemala: "GT",
    india: "IN", pakistan: "PK", bangladesh: "BD", "sri lanka": "LK",
    philippines: "PH", indonesia: "ID", malaysia: "MY", singapore: "SG",
    thailand: "TH", vietnam: "VN", japan: "JP", "south korea": "KR",
    "south africa": "ZA", nigeria: "NG", kenya: "KE", ghana: "GH", egypt: "EG",
    morocco: "MA", turkey: "TR", turkiye: "TR", israel: "IL",
    "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA", qatar: "QA"
};

// The UK's four nations are admin1 values in the database, so a country name
// can also pin the region
const SUBNATION_ADMIN = {
    england: "England", scotland: "Scotland",
    wales: "Wales", "northern ireland": "Northern Ireland"
};

// Friendliest name we know for a code, for display only ("GB" -> "United Kingdom").
// Longest matching name wins so we show the full name rather than an alias.
function countryLabel(code) {
    let best = null;
    for (const [name, cc] of Object.entries(COUNTRY_NAMES)) {
        if (cc !== code) continue;
        if (SUBNATION_ADMIN[name]) continue;        // "England" is not the country
        if (!best || name.length > best.length) best = name;
    }
    if (!best) return code;
    return best.replace(/\b[a-z]/g, ch => ch.toUpperCase());
}

function countryFromText(text) {
    const n = normalizeAdmin(text);
    if (!n) return null;
    if (COUNTRY_NAMES[n]) return COUNTRY_NAMES[n];
    if (/^[a-z]{2}$/.test(n)) return n.toUpperCase();   // already an ISO code
    return null;
}

// Does this candidate satisfy any of the hints the user typed after the city?
function scoreAgainstHints(candidate, hints) {
    let score = 0;
    for (const hint of hints) {
        const n = normalizeAdmin(hint);
        if (!n) continue;
        if (adminCodeMatches(candidate, n) === true) score += 100;
        if (normalizeAdmin(candidate.admin1_name) === n) score += 100;
        if (countryFromText(hint) === candidate.country) score += 80;
    }
    return score;
}

function regionCentroid(rows) {
    if (!rows || !rows.length) return null;
    return {
        lat: rows.reduce((s, c) => s + c.lat, 0) / rows.length,
        lon: rows.reduce((s, c) => s + c.lon, 0) / rows.length
    };
}

function countryRows(country, admin1) {
    if (!cityList) return [];
    return cityList.filter(c =>
        c.country === country && (!admin1 || c.admin1_name === admin1));
}

// Counties / districts, e.g. "Norfolk" in the UK. These are not cities, so the
// city index can't find them — but they are the level people naturally type,
// and small villages inside them (the reported "New York, Norfolk") are often
// absent from the database entirely.
function findAdmin2(text, wantCountry) {
    if (!cityList) return null;

    const target = normalizeAdmin(text);
    if (!target || target.length < 3) return null;

    const rows = cityList.filter(c =>
        c.admin2_name &&
        (!wantCountry || c.country === wantCountry) &&
        normalizeAdmin(c.admin2_name) === target);

    if (!rows.length) return null;

    // Several countries can share a county name; the biggest match wins
    const byCountry = new Map();
    for (const r of rows) {
        const k = `${r.country}|${r.admin1_name}`;
        if (!byCountry.has(k)) byCountry.set(k, []);
        byCountry.get(k).push(r);
    }

    const [, best] = [...byCountry.entries()]
        .sort((a, b) => {
            const pop = (g) => g.reduce((s, c) => s + (c.population || 0), 0);
            return pop(b[1]) - pop(a[1]);
        })[0];

    return best;
}

// Region lookup indexes, built once on first use (a 225k scan is fine for a
// one-off user action, and most sessions never open this panel).
let regionIndex = null;

function buildRegionIndex() {
    if (regionIndex || !cityList) return regionIndex;

    const admin1ByName = new Map();   // "new york" -> [rows]
    const admin2ByName = new Map();   // "norfolk"  -> [rows]
    const countries = new Set();

    for (const c of cityList) {
        countries.add(c.country);
        if (c.admin1_name) {
            const k = normalizeAdmin(c.admin1_name);
            if (!admin1ByName.has(k)) admin1ByName.set(k, []);
            admin1ByName.get(k).push(c);
        }
        if (c.admin2_name) {
            const k = normalizeAdmin(c.admin2_name);
            if (!admin2ByName.has(k)) admin2ByName.set(k, []);
            admin2ByName.get(k).push(c);
        }
    }

    regionIndex = { admin1ByName, admin2ByName, countries };
    return regionIndex;
}

const totalPopulation = (rows) => rows.reduce((s, c) => s + (c.population || 0), 0);

// Every region one piece of text could mean, most specific last. Ambiguity is
// real and unavoidable — "CA" is both Canada and California, "DE" is both
// Germany and Delaware — so we return all readings and let the rest of the
// query decide which one the user meant.
function scopeReadings(text) {
    const idx = buildRegionIndex();
    if (!idx) return [];

    const n = normalizeAdmin(text);
    if (!n) return [];

    const out = [];
    const push = (rows, extra) => { if (rows && rows.length) out.push({ rows, ...extra }); };

    // Country by name ("United Kingdom", "England")
    const named = COUNTRY_NAMES[n];
    if (named && idx.countries.has(named)) {
        const nation = SUBNATION_ADMIN[n] || null;
        push(countryRows(named, nation), { country: named, admin1: nation, coarse: !nation });
    }

    // Country by ISO code
    if (/^[a-z]{2}$/.test(n) && idx.countries.has(n.toUpperCase())) {
        const cc = n.toUpperCase();
        if (cc !== named) push(countryRows(cc, null), { country: cc, admin1: null, coarse: true });
    }

    // Region by postal/ISO code ("QC", "TX", and Sweden's single-letter "M").
    //
    // A code is only trustworthy on its own when we recognise it exactly. The
    // fuzzy "name starts with the code" reading matches dozens of regions
    // worldwide ("M" hits Maharashtra, Michigan, Madrid...), so it is marked
    // loose: usable to confirm a city found inside it, never an answer by itself.
    if (/^[a-z0-9]{1,3}$/.test(n)) {
        const byCode = new Map();
        for (const c of cityList) {
            if (adminCodeMatches(c, n) !== true) continue;
            const exact = !!ADMIN_CODE_NAMES[n.toUpperCase()] ||
                (c.admin1 && String(c.admin1).toUpperCase() === n.toUpperCase());
            const k = `${c.country}|${c.admin1_name}`;
            if (!byCode.has(k)) byCode.set(k, { rows: [], exact });
            byCode.get(k).rows.push(c);
        }
        for (const [k, { rows, exact }] of byCode) {
            const [country, admin1] = k.split("|");
            push(rows, { country, admin1, loose: !exact, fromCode: true });
        }
    }

    // Region by name ("New York", "Skåne")
    for (const rows of groupBy(idx.admin1ByName.get(n) || [], c => `${c.country}|${c.admin1_name}`)) {
        push(rows, { country: rows[0].country, admin1: rows[0].admin1_name });
    }

    // County / district by name ("Norfolk", "Kent")
    for (const rows of groupBy(idx.admin2ByName.get(n) || [], c => `${c.country}|${c.admin1_name}|${c.admin2_name}`)) {
        push(rows, { country: rows[0].country, admin1: rows[0].admin1_name, admin2: rows[0].admin2_name });
    }

    return out;
}

function groupBy(rows, keyOf) {
    const m = new Map();
    for (const r of rows) {
        const k = keyOf(r);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
    }
    return [...m.values()];
}

const inScope = (c, scope) =>
    (!scope.country || c.country === scope.country) &&
    (!scope.admin1 || c.admin1_name === scope.admin1) &&
    (!scope.admin2 || c.admin2_name === scope.admin2);

function placeResult(c) {
    return {
        country: c.country,
        admin1: c.admin1_name,
        admin2: c.admin2_name || null,
        lat: c.lat, lon: c.lon,
        viewLat: c.lat, viewLon: c.lon,
        label: `${c.name}, ${c.admin1_name || ""} ${c.country}`.replace(/\s+/g, " ").trim()
    };
}

function scopeResult(scope) {
    const centre = regionCentroid(scope.rows);
    if (!centre) return null;

    const label = scope.admin2 || scope.admin1
        ? `${scope.admin2 || scope.admin1}, ${countryLabel(scope.country)}`
        : countryLabel(scope.country);

    return {
        country: scope.country,
        admin1: scope.admin1 || null,
        admin2: scope.admin2 || null,
        // A whole country is too coarse to measure distance from; a region isn't
        lat: scope.coarse ? null : centre.lat,
        lon: scope.coarse ? null : centre.lon,
        viewLat: centre.lat,
        viewLon: centre.lon,
        coarse: !!scope.coarse,
        label
    };
}

// Resolve free text: "Montreal, QC" / "Palermo, New York" / "London, England" /
// "New York, Norfolk, United Kingdom" / "Canada".
//
// Addresses run specific-to-general, so the later parts set the scope and the
// earlier ones narrow inside it. Doing it this way rather than "first part that
// looks like a city wins" is what keeps "Palermo, New York" out of Sicily.
function resolveHomeText(text) {
    if (!cityIndex || !text) return null;

    const parts = text.split(",").map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;

    const results = [];

    // Try every part (broadest first) as the scope
    for (let i = parts.length - 1; i >= (parts.length > 1 ? 1 : 0); i--) {
        for (const scope of scopeReadings(parts[i])) {
            const narrowing = parts.slice(0, i);

            // Narrow by the earlier parts, most specific first
            for (const term of narrowing) {
                const cities = (cityIndex.get(normalize(term)) || []).filter(c => inScope(c, scope));
                if (cities.length) {
                    const best = cities.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
                    results.push({ rank: 3, pop: best.population || 0, out: placeResult(best) });
                    continue;
                }

                const counties = groupBy(
                    (buildRegionIndex()?.admin2ByName.get(normalizeAdmin(term)) || []).filter(c => inScope(c, scope)),
                    c => `${c.country}|${c.admin1_name}|${c.admin2_name}`);

                if (counties.length) {
                    const rows = counties.sort((a, b) => totalPopulation(b) - totalPopulation(a))[0];
                    results.push({
                        rank: 2, pop: totalPopulation(rows),
                        out: scopeResult({
                            rows, country: rows[0].country,
                            admin1: rows[0].admin1_name, admin2: rows[0].admin2_name
                        })
                    });
                }
            }

            // The scope on its own is an answer only if we actually recognised it.
            // A named region ("New York") outranks reading the first part as a
            // city; a bare code does not — "Malmo, M" means Malmö qualified by a
            // region code, not Munster, Ireland, whose code happens to be M.
            if (scope.loose) continue;
            const bare = scopeResult(scope);
            if (bare) results.push({ rank: scope.fromCode ? 0.5 : 1.5, pop: totalPopulation(scope.rows), out: bare });
        }
    }

    // A single bare word: treat it as a place name — unless it names a country,
    // in which case the country wins ("Canada" must not resolve to La Cañada)
    if (parts.length === 1 && !COUNTRY_NAMES[normalizeAdmin(parts[0])]) {
        const cities = cityIndex.get(normalize(parts[0])) || [];
        if (cities.length) {
            const best = [...cities].sort((a, b) => (b.population || 0) - (a.population || 0))[0];
            results.push({ rank: 3, pop: best.population || 0, out: placeResult(best) });
        }
    }

    // The first part read as a place name, with the rest as soft hints. Ranks
    // below a named region but above a bare code, so it rescues inputs whose
    // region code we cannot place, such as Sweden's "Malmo, M".
    if (parts.length > 1) {
        const cities = cityIndex.get(normalize(parts[0])) || [];
        if (cities.length) {
            const hints = parts.slice(1);
            const best = [...cities].sort((a, b) =>
                (scoreAgainstHints(b, hints) - scoreAgainstHints(a, hints)) ||
                ((b.population || 0) - (a.population || 0)))[0];
            results.push({ rank: 1, pop: best.population || 0, out: placeResult(best) });
        }
    }

    if (!results.length) return null;

    // Prefer the most specific reading; break ties on prominence
    results.sort((a, b) => (b.rank - a.rank) || (b.pop - a.pop));
    return results[0].out;
}

// Re-place listings that were geocoded before we knew the region.
//
// The first listings arrive before enough samples exist to infer a country, so
// they get placed with no context at all — a name like "Toronto" or "Paris"
// then lands on whichever namesake the database happened to list first, and it
// stayed there forever. Once the region is known, move them.
function regeocodeExisting(ctx) {
    if (!ctx) return;

    for (const l of globalListings) {
        const place = geocodeOffline(l.location || "", ctx);
        if (!place) continue;

        const [jLat, jLon] = jitter(place.lat, place.lon, 2000);
        jitterCache.set(l.url, { jLat, jLon });
        l.jLat = jLat;
        l.jLon = jLon;

        if (l._marker) l._marker.setLatLng([jLat, jLon]);
    }

    // The view was centred on one of those mis-placed pins
    if (ctx.lat && ctx.lon) map.setView([ctx.lat, ctx.lon], 11);
}

// Everything already on the map was placed using the old context, so start over
function resetGeocoding() {
    searchContext = null;
    droppedByRegion = 0;
    contextSamples = [];
    addedItems.clear();
    globalListings = [];
    jitterCache.clear();
    clearMapMarkers();
    initialLocationSet = null;
}

let lastOpenedItemKey = null;

// -----------------------------
// Tools / filters state
// -----------------------------
const MARKER_COLORS = {
    default: "#3b6fd4",
    bookmark: "#f4b400",
    free: "#0f9d58",
    fresh: "#ff6d00"
};

const FREE_WORDS = [
    "free", "gratis", "kostenlos",
    "gratuit", "gratuito", "gratuita",
    "za darmo", "besplatno",
    "ilmainen", "ingyenes",
    "бесплатно"
];

let bookmarks = loadBookmarks();      // Set of itemKeys
let filterBookmarksOnly = false;
let filterFreeOnly = false;
let filterNewOnly = false;
let colorByFreshness = true;
let priceMin = null;
let priceMax = null;

// -----------------------------
// Bookmarks persistence
// -----------------------------
function loadBookmarks() {
    try {
        return new Set(JSON.parse(localStorage.getItem("mkpm-bookmarks") || "[]"));
    } catch {
        return new Set();
    }
}

function saveBookmarks() {
    localStorage.setItem("mkpm-bookmarks", JSON.stringify([...bookmarks]));
}

// -----------------------------
// Seen-listings history
//
// Everything scraped used to die on reload. Remembering which items we've
// already shown lets the map answer the question that actually brings people
// back: "what's new since I last looked?"
// -----------------------------
const HISTORY_LIMIT = 4000;          // ~a few hundred KB of localStorage
const SESSION_GAP_MS = 30 * 60 * 1000; // a return after 30min counts as a new visit

let seenHistory = loadHistory();     // itemKey -> firstSeen (epoch ms)
let previousVisitAt = 0;             // "new" means: first seen after this
let newSinceLastVisit = new Set();   // itemKeys that are new this visit
let historyDirty = false;

function loadHistory() {
    try {
        const raw = JSON.parse(localStorage.getItem("mkpm-history") || "{}");
        return new Map(Object.entries(raw));
    } catch {
        return new Map();
    }
}

function saveHistory() {
    if (!historyDirty) return;
    historyDirty = false;

    // Keep the newest entries when we outgrow the cap
    let entries = [...seenHistory.entries()];
    if (entries.length > HISTORY_LIMIT) {
        entries.sort((a, b) => b[1] - a[1]);
        entries = entries.slice(0, HISTORY_LIMIT);
        seenHistory = new Map(entries);
    }

    try {
        localStorage.setItem("mkpm-history", JSON.stringify(Object.fromEntries(entries)));
    } catch {
        // Storage full: drop the oldest half and give up quietly on failure
        seenHistory = new Map(entries.slice(0, Math.floor(entries.length / 2)));
        try {
            localStorage.setItem("mkpm-history", JSON.stringify(Object.fromEntries(seenHistory)));
        } catch { /* not worth breaking the map over */ }
    }
}

// Establish the "since" line for this visit, then start a new one.
function startVisit() {
    const now = Date.now();
    const last = Number(localStorage.getItem("mkpm-last-visit") || 0);

    // Reloading the page mid-browse shouldn't wipe out what was marked new
    previousVisitAt = (last && now - last < SESSION_GAP_MS)
        ? Number(localStorage.getItem("mkpm-visit-anchor") || last)
        : last;

    localStorage.setItem("mkpm-visit-anchor", String(previousVisitAt));
    localStorage.setItem("mkpm-last-visit", String(now));
}

// Record an item and report whether it's new since the last visit
function noteSeen(itemKey) {
    if (!itemKey) return false;

    if (seenHistory.has(itemKey)) {
        return newSinceLastVisit.has(itemKey);
    }

    const now = Date.now();
    seenHistory.set(itemKey, now);
    historyDirty = true;

    // Nothing is "new" on a first-ever run — everything would be, which is noise
    const isNew = previousVisitAt > 0;
    if (isNew) newSinceLastVisit.add(itemKey);
    return isNew;
}

function isNewListing(itemKey) {
    return !!itemKey && newSinceLastVisit.has(itemKey);
}

// -----------------------------
// Free-item detection (mirrors content.js FREE_WORDS)
// -----------------------------
function isFreeListing(price) {
    if (!price) return false;
    const t = String(price).toLowerCase().trim();
    return FREE_WORDS.some(w => t === w || t.startsWith(w + " ") || t.startsWith(w));
}

// -----------------------------
// Extract a comparable numeric value from a price string.
// Handles thousands/decimal separators across locales; free = 0.
// -----------------------------
function extractPriceValue(price) {
    if (price == null) return null;
    if (isFreeListing(price)) return 0;

    const m = String(price).match(/\d[\d.,\s]*\d|\d/);
    if (!m) return null;

    let s = m[0].replace(/\s/g, "");

    // Drop a trailing decimal group (1-2 digits after the last separator)
    const dec = s.match(/[.,]\d{1,2}$/);
    if (dec) s = s.slice(0, dec.index);

    s = s.replace(/[.,]/g, "");
    const val = parseInt(s, 10);
    return Number.isFinite(val) ? val : null;
}

// -----------------------------
// Marker color + icon
// -----------------------------
function getMarkerColor(listing, itemKey) {
    if (itemKey && bookmarks.has(itemKey)) return MARKER_COLORS.bookmark;
    if (colorByFreshness) {
        if (isFreeListing(listing.price)) return MARKER_COLORS.free;
        if (listing.badge) return MARKER_COLORS.fresh;
    }
    return MARKER_COLORS.default;
}

function makePinIcon(color, starred, isNew) {
    return L.divIcon({
        className: "mkp-pin-wrap",
        html: `<div class="mkp-pin${isNew ? " mkp-pin-new" : ""}" style="background:${color}">${starred ? "★" : ""}</div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        popupAnchor: [0, -10],
        tooltipAnchor: [11, 0]
    });
}

// -----------------------------
// Filters
// -----------------------------
function passesFilters(listing, itemKey) {
    if (filterBookmarksOnly && !(itemKey && bookmarks.has(itemKey))) return false;
    if (filterFreeOnly && !isFreeListing(listing.price)) return false;
    if (filterNewOnly && !isNewListing(itemKey)) return false;

    if (areaPolygon && !pointInArea(listing.jLat, listing.jLon)) return false;

    if (priceMin != null || priceMax != null) {
        const val = extractPriceValue(listing.price);
        if (val != null) { // unparseable prices stay visible
            if (priceMin != null && val < priceMin) return false;
            if (priceMax != null && val > priceMax) return false;
        }
    }
    return true;
}

function updateMarkerVisibility(marker) {
    const show = passesFilters(marker.listing, marker.itemKey);
    if (show) {
        if (!markerLayerGroup.hasLayer(marker)) markerLayerGroup.addLayer(marker);
    } else if (markerLayerGroup.hasLayer(marker)) {
        markerLayerGroup.removeLayer(marker);
    }
}

function applyFilters() {
    for (const m of markers) updateMarkerVisibility(m);
}

function refreshMarkerStyles() {
    for (const m of markers) {
        m.setIcon(makePinIcon(
            getMarkerColor(m.listing, m.itemKey),
            bookmarks.has(m.itemKey),
            isNewListing(m.itemKey)
        ));
    }
}

// -----------------------------
// Draw-an-area filter
//
// The one thing a map can do that Marketplace's own list view cannot: "only
// show me things I'd actually be willing to travel to." Freehand lasso, no
// plugins — Leaflet gives us the container-point → LatLng conversion.
// -----------------------------
let areaPolygon = null;      // Leaflet polygon currently filtering the map
let areaLatLngs = null;      // its raw [lat, lng] ring, for hit-testing
let areaDrawMode = false;    // waiting for / capturing a drag

// Ray casting against the drawn ring
function pointInArea(lat, lon) {
    if (!areaLatLngs || lat == null || lon == null) return true;

    let inside = false;
    for (let i = 0, j = areaLatLngs.length - 1; i < areaLatLngs.length; j = i++) {
        const [yi, xi] = areaLatLngs[i];
        const [yj, xj] = areaLatLngs[j];
        const intersects = (yi > lat) !== (yj > lat)
            && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

function clearArea() {
    if (areaPolygon) map.removeLayer(areaPolygon);
    areaPolygon = null;
    areaLatLngs = null;
}

function setAreaDrawMode(on) {
    areaDrawMode = on;
    const el = map.getContainer();
    el.classList.toggle("mkp-drawing", on);

    // The map must stop panning while the pointer is being used to draw
    if (on) {
        map.dragging.disable();
        map.doubleClickZoom.disable();
    } else {
        map.dragging.enable();
        map.doubleClickZoom.enable();
    }
}

function setupAreaDrawing() {
    const el = map.getContainer();
    let points = [];       // container-space points
    let preview = null;
    let drawing = false;

    const toLatLng = (pt) => {
        const ll = map.containerPointToLatLng(pt);
        return [ll.lat, ll.lng];
    };

    const onDown = (e) => {
        if (!areaDrawMode || e.button !== 0) return;
        e.preventDefault();
        drawing = true;
        points = [];
        clearArea();

        const rect = el.getBoundingClientRect();
        points.push([e.clientX - rect.left, e.clientY - rect.top]);

        preview = L.polyline([toLatLng(points[0])], {
            color: "#354c80", weight: 2, dashArray: "4 4"
        }).addTo(map);

        el.setPointerCapture?.(e.pointerId);
    };

    const onMove = (e) => {
        if (!drawing) return;
        const rect = el.getBoundingClientRect();
        const pt = [e.clientX - rect.left, e.clientY - rect.top];

        // Skip micro-movements so the ring stays cheap to hit-test
        const last = points[points.length - 1];
        if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 4) return;

        points.push(pt);
        preview.addLatLng(toLatLng(pt));
    };

    const onUp = () => {
        if (!drawing) return;
        drawing = false;
        if (preview) { map.removeLayer(preview); preview = null; }

        // A stray click isn't an area
        if (points.length < 8) {
            setAreaDrawMode(false);
            setBtnActive(document.getElementById("mkp-tool-area"), false);
            applyFilters();
            return;
        }

        areaLatLngs = points.map(toLatLng);
        areaPolygon = L.polygon(areaLatLngs, {
            color: "#354c80", weight: 2, fillColor: "#354c80", fillOpacity: .08
        }).addTo(map);

        setAreaDrawMode(false);
        applyFilters();
        updateAreaHint();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
}

function updateAreaHint() {
    const hint = document.getElementById("mkp-area-hint");
    if (!hint) return;

    if (areaDrawMode) {
        hint.textContent = "Draw an area on the map";
        hint.style.display = "block";
    } else if (areaPolygon) {
        const shown = markers.filter(m => markerLayerGroup.hasLayer(m)).length;
        hint.textContent = `${shown} listing${shown === 1 ? "" : "s"} in your area. Click the area tool to clear`;
        hint.style.display = "block";
    } else {
        hint.style.display = "none";
    }
}

// -----------------------------
// Wire up the tools row
// -----------------------------
function setBtnActive(btn, on) {
    if (btn) btn.classList.toggle("active", !!on);
}

// Tooltips are centered on their button by default, which clips them against
// the panel edges (the map is only ~420px wide). Re-anchor the ones that would
// overflow to their left/right edge instead. Pseudo-elements can't be measured
// directly, so mirror the bubble in an off-screen node to get its real width.
let ttRuler = null;

function measureTooltip(text) {
    if (!ttRuler) {
        ttRuler = document.createElement("div");
        Object.assign(ttRuler.style, {
            position: "absolute",
            top: "-9999px",
            left: "-9999px",
            visibility: "hidden",
            fontSize: ".68rem",
            lineHeight: "1.3",
            padding: "4px 8px",
            width: "max-content",
            maxWidth: "190px",
            whiteSpace: "normal"
        });
        document.body.appendChild(ttRuler);
    }
    ttRuler.textContent = text;
    return ttRuler.getBoundingClientRect().width;
}

function anchorTooltips() {
    const panelWidth = document.documentElement.clientWidth;
    const MARGIN = 6;

    document.querySelectorAll("[data-tooltip]").forEach(el => {
        // Elements with an explicit anchor in the markup keep it
        if (el.dataset.ttFixed === "true") return;

        const rect = el.getBoundingClientRect();
        if (!rect.width) return;

        const half = measureTooltip(el.dataset.tooltip) / 2;
        const center = rect.left + rect.width / 2;

        el.classList.toggle("tt-left", center - half < MARGIN);
        el.classList.toggle("tt-right", center + half > panelWidth - MARGIN);
    });
}

function setupTools() {
    // Auto-load listings (runs in the page via content.js)
    const autoBtn = document.getElementById("mkp-tool-autoload");
    if (autoBtn) {
        const savedAuto = localStorage.getItem("mkpm-autoscroll") === "true";
        setBtnActive(autoBtn, savedAuto);
        if (savedAuto) parent.postMessage({ type: "toggle-autoscroll", enabled: true }, "*");

        autoBtn.addEventListener("click", () => {
            const on = !autoBtn.classList.contains("active");
            setBtnActive(autoBtn, on);
            localStorage.setItem("mkpm-autoscroll", String(on));
            parent.postMessage({ type: "toggle-autoscroll", enabled: on }, "*");
        });
    }

    // Bookmarks only
    const bmBtn = document.getElementById("mkp-tool-bookmarks");
    if (bmBtn) {
        bmBtn.addEventListener("click", () => {
            filterBookmarksOnly = !filterBookmarksOnly;
            setBtnActive(bmBtn, filterBookmarksOnly);
            applyFilters();
        });
    }

    // New since last visit
    const newBtn = document.getElementById("mkp-tool-new");
    if (newBtn) {
        newBtn.addEventListener("click", () => {
            filterNewOnly = !filterNewOnly;
            setBtnActive(newBtn, filterNewOnly);
            applyFilters();
            updateAreaHint();
        });
    }

    // Draw an area to filter by
    const areaBtn = document.getElementById("mkp-tool-area");
    if (areaBtn) {
        areaBtn.addEventListener("click", () => {
            if (areaPolygon || areaDrawMode) {
                // Second click clears whatever is active
                clearArea();
                setAreaDrawMode(false);
                setBtnActive(areaBtn, false);
                applyFilters();
            } else {
                setAreaDrawMode(true);
                setBtnActive(areaBtn, true);
            }
            updateAreaHint();
        });
    }

    // Free items only
    const freeBtn = document.getElementById("mkp-tool-free");
    if (freeBtn) {
        freeBtn.addEventListener("click", () => {
            filterFreeOnly = !filterFreeOnly;
            setBtnActive(freeBtn, filterFreeOnly);
            applyFilters();
        });
    }

    // Color by freshness (persisted preference; on by default)
    const colorBtn = document.getElementById("mkp-tool-color");
    if (colorBtn) {
        colorByFreshness = localStorage.getItem("mkpm-color-freshness") !== "false";
        setBtnActive(colorBtn, colorByFreshness);
        colorBtn.addEventListener("click", () => {
            colorByFreshness = !colorByFreshness;
            setBtnActive(colorBtn, colorByFreshness);
            localStorage.setItem("mkpm-color-freshness", String(colorByFreshness));
            refreshMarkerStyles();
        });
    }

    // Price range popover
    const priceBtn = document.getElementById("mkp-tool-price");
    const pricePanel = document.getElementById("mkp-price-panel");
    const minInput = document.getElementById("mkp-price-min");
    const maxInput = document.getElementById("mkp-price-max");
    const clearBtn = document.getElementById("mkp-price-clear");

    if (priceBtn && pricePanel && minInput && maxInput) {
        priceBtn.addEventListener("click", () => {
            const on = pricePanel.style.display !== "block";
            pricePanel.style.display = on ? "block" : "none";
            priceBtn.toggleAttribute("data-tt-off", on);
        });

        const onPrice = () => {
            priceMin = minInput.value !== "" ? Number(minInput.value) : null;
            priceMax = maxInput.value !== "" ? Number(maxInput.value) : null;
            setBtnActive(priceBtn, priceMin != null || priceMax != null);
            applyFilters();
        };

        minInput.addEventListener("input", onPrice);
        maxInput.addEventListener("input", onPrice);

        if (clearBtn) {
            clearBtn.addEventListener("click", () => {
                minInput.value = "";
                maxInput.value = "";
                onPrice();
                pricePanel.style.display = "none";
                priceBtn.removeAttribute("data-tt-off");
            });
        }
    }

    // Home region popover
    const homeBtn = document.getElementById("mkp-tool-home");
    const homePanel = document.getElementById("mkp-home-panel");
    const homeInput = document.getElementById("mkp-home-input");
    const homeApply = document.getElementById("mkp-home-apply");
    const homeClear = document.getElementById("mkp-home-clear");
    const homeStatus = document.getElementById("mkp-home-status");

    if (homeBtn && homePanel && homeInput) {
        const renderHome = () => {
            setBtnActive(homeBtn, !!homeContext);
            if (homeStatus) {
                homeStatus.textContent = homeContext
                    ? `Using ${homeContext.label || homeContext.admin1 || homeContext.country}`
                    : "Auto-detected from listings";
            }
        };
        renderHome();

        const showHomePanel = (on) => {
            homePanel.style.display = on ? "block" : "none";
            homeBtn.toggleAttribute("data-tt-off", on);
            if (on) homeInput.focus();
        };

        homeBtn.addEventListener("click", () => {
            showHomePanel(homePanel.style.display !== "block");
        });

        const apply = () => {
            const text = homeInput.value.trim();
            if (!text) return;

            const resolved = resolveHomeText(text);
            if (!resolved) {
                if (homeStatus) homeStatus.textContent = `Couldn't find "${text}"`;
                return;
            }

            saveHomeContext(resolved);
            renderHome();
            resetGeocoding();

            // A country-level pick centres on a whole nation, so zoom out for it
            if (resolved.viewLat != null && resolved.viewLon != null) {
                map.setView([resolved.viewLat, resolved.viewLon], resolved.coarse ? 5 : 11);
            }
            showHomePanel(false);
        };

        homeApply?.addEventListener("click", apply);
        homeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });

        homeClear?.addEventListener("click", () => {
            saveHomeContext(null);
            homeInput.value = "";
            renderHome();
            resetGeocoding();
            showHomePanel(false);
        });
    }

    anchorTooltips();
    window.addEventListener("resize", anchorTooltips);
}

// -----------------------------
// Auto-load spinner overlay (driven by content.js sweep status)
// -----------------------------
// -----------------------------
// Silent-failure banner
//
// Driven by content.js. When scraping stops working the map just goes blank,
// which reads as "this extension is dead" — say what happened and give people
// a way to report it instead.
// -----------------------------
function setScrapeHealth(status) {
    const el = document.getElementById("mkp-health");
    if (!el) return;

    if (!status || status === "ok") {
        el.style.display = "none";
        return;
    }

    const msg = status === "unparsed"
        ? "Listings are visible but can't be read. Facebook may have changed their layout."
        : "No listings found on this page. If you can see listings, the extension may need an update.";

    const subject = encodeURIComponent(`Marketplace Map: scraping issue (${status})`);
    el.innerHTML = `<span>${msg}</span>
        <a href="mailto:guille.sotelo.cloud@gmail.com?subject=${subject}" target="_blank">Report</a>`;
    el.style.display = "flex";
}

// An empty map is the worst outcome: it looks broken and says nothing. If a
// region the user set is what emptied it, say so and offer the way out — this
// is the safety net for every place name the database can't resolve properly.
function updateRegionWarning() {
    const el = document.getElementById("mkp-region-warn");
    if (!el) return;

    const shouldWarn = !!homeContext && markers.length === 0 && droppedByRegion > 0;
    el.style.display = shouldWarn ? "flex" : "none";
    if (!shouldWarn) return;

    // Nothing will ever be placed in this state, so stop pretending to load
    document.getElementById("map-loading")?.remove();

    const where = homeContext.label || homeContext.admin1 || homeContext.country;
    el.innerHTML =
        `<span>${droppedByRegion} listing${droppedByRegion === 1 ? "" : "s"} hidden, ` +
        `they aren't in <b>${where}</b>.</span>` +
        `<button type="button" id="mkp-region-reset">Use auto</button>`;

    el.querySelector("#mkp-region-reset").onclick = () => {
        saveHomeContext(null);
        droppedByRegion = 0;
        resetGeocoding();
        el.style.display = "none";

        const btn = document.getElementById("mkp-tool-home");
        setBtnActive(btn, false);
        const status = document.getElementById("mkp-home-status");
        if (status) status.textContent = "Auto-detected from listings";
    };
}

// Tell content.js the panel is worth showing. It reveals on this instead of a
// fixed delay, so a fast page no longer waits the full backstop.
let announcedReady = false;

function announceMapReady() {
    if (announcedReady) return;
    announcedReady = true;
    parent.postMessage({ type: "map-ready" }, "*");
}

function setAutoloadSpinner(running, progress = 0) {
    const el = document.getElementById("mkp-autoload-spinner");
    if (el) el.style.display = running ? "flex" : "none";

    const bar = document.getElementById("mkp-autoload-bar");
    if (bar) bar.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

// -----------------------------
// Detect new search
// -----------------------------
function isNewSearch(data) {
    const signature = data.url;
    // Ignore newSearch when opening an item
    // TODO: add the item if not added before to the map (scrape differently)
    if (!signature.includes('/item/') && signature !== lastSearchSignature) {
        lastSearchSignature = signature;
        return true;
    }
    return false;
}

// -----------------------------
// Detect item view & item already scraped (skip refresh)
// -----------------------------
function isItemView(data) {
    const signature = data.url;
    const itemScraped = data.itemScraped;
    if (signature.includes('/item/') && itemScraped) {
        return true;
    }
    return false;
}


// -----------------------------
// Get item ID url
// -----------------------------
function extractMarketplaceItemKey(url) {
    if (!url) return null;

    try {
        const u = new URL(url);

        const match = u.pathname.match(/^\/marketplace\/item\/(\d+)/);
        if (!match) return null;

        return match[1]; // ← ONLY the ID
    } catch {
        return null;
    }
}

// -----------------------------
// Open listing popup by URL - ID matching
// -----------------------------
function openListingOnMapByUrl(currentUrl) {
    const key = extractMarketplaceItemKey(currentUrl);
    if (!key) return;

    const marker = markerByItemKey.get(key);
    if (!marker) return;

    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14), {
        animate: true
    });

    marker.openPopup();
}


// -----------------------------
// Load City DB
// -----------------------------
async function loadCityDB() {
    const url = chrome.runtime.getURL("data/cities_db.json.gz");
    const res = await fetch(url);
    const buf = await res.arrayBuffer();

    const decompressed = pako.inflate(new Uint8Array(buf));
    let arr = JSON.parse(new TextDecoder().decode(decompressed));

    // If arr is an object (dictionary), convert to array of city objects
    if (!Array.isArray(arr)) {
        arr = Object.values(arr);   // <-- this is the key
    }

    cityIndex = new Map();
    cityList = arr;

    for (const city of arr) {
        const allNames = [city.name, ...(city.aliases || [])];
        for (const name of allNames) {
            const norm = normalize(name);
            if (!cityIndex.has(norm)) cityIndex.set(norm, []);
            cityIndex.get(norm).push(city);
        }
    }

    // console.log("City DB loaded:", arr.length, "cities,", cityIndex.size, "unique keys");
}


// -----------------------------
// Normalize
// -----------------------------
function normalize(text) {
    if (!text) return "";
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[–—]/g, "-")
        .replace(/\b(near|nära|près de|cerca de|vicino a|en|in|on)\b/g, "")
        .replace(/\b(county|province|region|state|kommun|län)\b/g, "")
        .replace(/[^a-z0-9 ,.-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}


// -----------------------------
// Offline geocode
// -----------------------------
// normalize() strips the standalone words "en", "in" and "on" so that phrases
// like "near X" reduce cleanly — but those are also the postal codes for
// Ontario and Indiana, which normalize() therefore erased entirely. Region
// codes get their own normalizer with the stop-word pass left out.
function normalizeAdmin(text) {
    if (!text) return "";
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[–—]/g, "-")
        .replace(/[^a-z0-9 ,.-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Subdivision codes Facebook writes that are not a prefix of the region's name.
// Without these, "Montreal, QC" scored every Quebec candidate -200 (because
// "quebec" does not start with "qc") and the correct city lost to a namesake.
const ADMIN_CODE_NAMES = {
    // Canada
    AB: "alberta", BC: "british columbia", MB: "manitoba", NB: "new brunswick",
    NL: "newfoundland and labrador", NS: "nova scotia", NT: "northwest territories",
    NU: "nunavut", ON: "ontario", PE: "prince edward island", QC: "quebec",
    SK: "saskatchewan", YT: "yukon",
    // US states whose postal code doesn't prefix the name
    AK: "alaska", AZ: "arizona", CT: "connecticut", HI: "hawaii", MA: "massachusetts",
    MD: "maryland", ME: "maine", MI: "michigan", MN: "minnesota", MO: "missouri",
    MS: "mississippi", MT: "montana", NC: "north carolina", NH: "new hampshire",
    NJ: "new jersey", NM: "new mexico", NY: "new york", PR: "puerto rico",
    RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee",
    TX: "texas", VT: "vermont", WV: "west virginia"
};

// true = the candidate is in that subdivision, false = it definitely isn't,
// null = we can't interpret the code, so stay neutral rather than guess.
// Neutral matters: many countries use codes we don't know ("Malmö, M"), and the
// old code punished every candidate equally, which just threw the signal away.
function adminCodeMatches(candidate, listingAdmin) {
    if (!listingAdmin) return null;

    const code = listingAdmin.toUpperCase();
    const cAdmin = normalizeAdmin(candidate.admin1_name);

    const known = ADMIN_CODE_NAMES[code];
    if (known) return cAdmin === known;

    // GeoNames stores US-style codes directly in admin1
    if (candidate.admin1 && String(candidate.admin1).toUpperCase() === code) return true;

    // Counties / districts, e.g. "Norwich, Norfolk". Only ever a positive
    // signal — a mismatch here says nothing, since most listings name a region
    // rather than a county.
    if (candidate.admin2_name && normalizeAdmin(candidate.admin2_name) === listingAdmin) return true;

    if (cAdmin && cAdmin.startsWith(listingAdmin)) return true;

    return null;
}

function geocodeOffline(text, context = null) {
    if (!cityIndex || !text) return null;

    const parts = text.split(",").map(x => x.trim());
    const cityPart = normalize(parts[0]);
    const adminPart = parts[1] ? normalizeAdmin(parts[1]) : null;

    const candidates = cityIndex.get(cityPart);
    if (!candidates || !candidates.length) return null;

    let best = null;
    let bestScore = -Infinity;

    for (const c of candidates) {
        let score = 0;

        const cAdmin = normalize(c.admin1_name);
        const ctxAdmin = context?.admin1 ? normalize(context.admin1) : null;
        const listingAdmin =
            adminPart && adminPart.length <= 3 ? adminPart : null;

        /* ----------------------------------
         Explicit listing admin (strongest)
        ---------------------------------- */
        const adminVerdict = adminCodeMatches(c, listingAdmin);
        if (adminVerdict === true) score += 300;
        else if (adminVerdict === false) score -= 200;

        /* ----------------------------------
         Search intent (soft lock / context)

         Applied even when the listing names an admin: an unreadable code
         leaves every candidate tied, and the context is then the only thing
         that can break the tie correctly.
        ---------------------------------- */
        if (lockedAdmin1) {
            if (cAdmin === lockedAdmin1) score += 120;
            else score -= 40;
        }

        if (ctxAdmin && cAdmin === ctxAdmin) {
            score += 100;
        }

        /* ----------------------------------
           Country
        ---------------------------------- */
        if (context?.country &&
            normalize(c.country) === normalize(context.country)) {
            score += 60;
        }

        /* ----------------------------------
           Prominence

           Deliberately small: at most ~24 points for a ten-million city versus
           ~9 for a village, so it separates otherwise-tied namesakes without
           ever outweighing an explicit region (300) or the country (60).
           Before this the winner among tied candidates was simply whichever
           one the database happened to list first.
        ---------------------------------- */
        if (c.population > 0) score += Math.log10(c.population + 1) * 3;

        /* ----------------------------------
            Distance (weakest signal)
        ---------------------------------- */
        if (context?.lat && context?.lon) {
            const dLat = c.lat - context.lat;
            const dLon = c.lon - context.lon;
            const dist = Math.sqrt(dLat * dLat + dLon * dLon);
            score -= dist * 30;
        }

        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best;
}





// -----------------------------
// Jitter coords
// -----------------------------
function jitter(lat, lon, meters = 2000) {
    const latOffset = (Math.random() - 0.5) * (meters / 111000);
    const lonOffset = (Math.random() - 0.5) * (meters / (111000 * Math.cos(lat * Math.PI / 180)));
    return [lat + latOffset, lon + lonOffset];
}


// -----------------------------
// Create map + layer
// -----------------------------
async function initMap() {
    try {
        await loadCityDB();
    } catch (e) {
        console.error("MKP Mapper: failed to load city DB", e);
    }

    // prefix: false drops Leaflet's own "Leaflet" credit, leaving just the two
    // credits we are actually required to show
    map = L.map("mkp-mapper-map", { attributionControl: false });
    L.control.attribution({ prefix: false, position: "bottomright" }).addTo(map);

    L.tileLayer(basemapUrl(), {
        subdomains: "abcd",     // CARTO serves a-d; Leaflet defaults to a-c
        maxZoom: 20,
        attribution: BASEMAP.attribution
    }).addTo(map);

    markerLayerGroup = L.layerGroup().addTo(map);

    // Replay anything that arrived while the database was loading
    if (pendingListings) {
        const held = pendingListings;
        pendingListings = null;
        setTimeout(() => window.postMessage(held, "*"), 0);
    }

    // Default world view — removed as soon as first marker lands
    map.setView([20, 0], 2);

    // Safety timeout: if no listings geocoded after 8s, reveal the map as-is
    setTimeout(() => {
        const overlay = document.getElementById("map-loading");
        if (overlay) overlay.remove();
    }, 8000);
}


// -----------------------------
// Clear markers
// -----------------------------
function clearMapMarkers() {
    if (markerLayerGroup) markerLayerGroup.clearLayers();
    markers = [];
}


// -----------------------------
// Parse price to show previous price properly
// -----------------------------
function parsePrice(price) {
    if (!price) return '-';

    const tokens = price.match(
        /(?:[^\d\s]{1,3}\s*)?\d[\d.,\s]*\d(?:\s*[^\d\s]{1,3})?/g
    );

    if (!tokens || tokens.length === 0) return price;

    // Single price → return as-is
    if (tokens.length === 1) {
        return `<span>${tokens[0].trim()}</span>`;
    }

    // Two prices → new + old
    const [newPrice, oldPrice] = tokens;

    return `
        <span>${newPrice.trim()}</span>
        <span style="text-decoration: line-through; color: #888; margin-left: .25rem;">
            ${oldPrice.trim()}
        </span>
    `;
}


// -----------------------------
// Add one marker
// -----------------------------
function addMarkerToMap(listing) {
    if (!listing.jLat || !listing.jLon) return;
    const itemKey = extractMarketplaceItemKey(listing.url);
    const isNew = noteSeen(itemKey);
    let popupHtml = `
        <div style="display: flex; flex-direction: column; margin: 0 .5rem .5rem;">
            ${isNew ? `<span class="mkp-new-chip">NEW since your last visit</span>` : ""}
            <p style="margin: 0; font-size: .9rem; font-weight: bold;">${parsePrice(listing.price)}<p>
            <p style="margin: 0;">${listing.title}</p>
            <p style="margin: 0 0 .3rem 0; font-size: .8rem; color: #858585;">${listing.location}</p>
            <div style="display: flex; align-items: center; gap: .6rem;">
                <a href="${listing.url}" target="_blank">Open Listing</a>
                ${itemKey ? `<button class="mkp-bookmark-btn" type="button"
                    style="background: none; border: none; cursor: pointer; font-size: .8rem; color: #b8860b; padding: 0;"></button>` : ""}
            </div>
            </div>
            `;
    if (listing.image) {
        popupHtml = `
            <div style="posiion: relative;">
                ${listing.badge ?
                `<p 
                        style="margin: 0; 
                        font-size: .75rem; 
                        font-style: italic; 
                        position: absolute; 
                        top: 0; 
                        left: 0; 
                        padding: .2rem .4rem; 
                        background: #fff; 
                        border-top-left-radius: .5rem;
                        border-bottom-right-radius: .5rem;"
                        >${listing.badge}<p>`
                : ''}
                <a href="${listing.url}" target="_blank">
                    <img src="${listing.image}" style="width: 100%; height: auto;">
                </a>
                <br>
            </div>` + popupHtml;
    }

    let tooltipHtml = `
        <img src="${listing.image}" style="width: 100px; height: auto; border-radius: .5rem;">
        <p style="font-size: .75rem; font-weight: bold; margin: .6rem .2rem; padding: 0;">${parsePrice(listing.price)}</p>
    `

    const marker = L.marker([listing.jLat, listing.jLon], {
        icon: makePinIcon(getMarkerColor(listing, itemKey), itemKey && bookmarks.has(itemKey), isNew)
    })
        .bindPopup(popupHtml)
        .bindTooltip(tooltipHtml);

    marker.listing = listing;
    marker.itemKey = itemKey;
    listing._marker = marker;   // so a later region fix can move it
    marker.on("popupopen", onPopupOpen);

    markers.push(marker);
    if (itemKey) markerByItemKey.set(itemKey, marker);

    updateMarkerVisibility(marker);
}

// -----------------------------
// Bookmark toggle inside a popup
// -----------------------------
function onPopupOpen(e) {
    const marker = e.target;
    if (!marker.itemKey) return;

    const el = marker.getPopup().getElement();
    const btn = el && el.querySelector(".mkp-bookmark-btn");
    if (!btn) return;

    const render = () => {
        const on = bookmarks.has(marker.itemKey);
        btn.textContent = on ? "★ Saved" : "☆ Save";
    };
    render();

    btn.onclick = () => {
        if (bookmarks.has(marker.itemKey)) bookmarks.delete(marker.itemKey);
        else bookmarks.add(marker.itemKey);
        saveBookmarks();
        marker.setIcon(makePinIcon(
            getMarkerColor(marker.listing, marker.itemKey),
            bookmarks.has(marker.itemKey),
            isNewListing(marker.itemKey)
        ));
        render();
        updateMarkerVisibility(marker); // in case the bookmarks-only filter is active
    };
}


// -----------------------------
// Helper for collecting candidate cities per listing
// -----------------------------
// One entry per listing, holding that listing's candidate cities.
//
// This used to spread every candidate into a flat array, so a single listing in
// a city with many same-named twins (Montreal has 11) blew past the sample
// limit on its own — the whole session's country was then decided by one
// listing's name collisions.
function collectContextSample(locationText) {
    if (!locationText) return;

    const cityKey = normalize(locationText.split(",")[0]);
    const candidates = cityIndex.get(cityKey);
    if (!candidates || !candidates.length) return;

    contextSamples.push(candidates);
}


// -----------------------------
// Infer the most likely context for init location
// -----------------------------
// Pick the country/region that best explains the whole batch of listings.
//
// Each listing votes at most once per country, so a place name with seven
// same-named twins abroad can't outvote seven listings that all agree. Quebec
// was the case that exposed this: French-Canadian city names (Laval, Verdun,
// Montréal, Mirabel…) each match several French communes, so counting raw
// candidates concluded "France" and plotted the map in Occitanie.
function inferContext(groups) {
    const countryListings = new Map();  // country -> listings it can explain
    const adminListings = new Map();    // "country|admin1" -> same

    for (const candidates of groups) {
        const countries = new Set();
        const admins = new Set();

        for (const c of candidates) {
            countries.add(c.country);
            if (c.admin1_name) admins.add(`${c.country}|${c.admin1_name}`);
        }

        for (const k of countries) countryListings.set(k, (countryListings.get(k) || 0) + 1);
        for (const k of admins) adminListings.set(k, (adminListings.get(k) || 0) + 1);
    }

    const bestAdminFor = (country) =>
        [...adminListings.entries()]
            .filter(([k]) => k.startsWith(country + "|"))
            .sort((a, b) => b[1] - a[1])[0];

    // Rank by how many listings a country explains, then by how tightly those
    // listings concentrate into one region — a real search sits in one area.
    const bestCountry = [...countryListings.entries()]
        .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return (bestAdminFor(b[0])?.[1] || 0) - (bestAdminFor(a[0])?.[1] || 0);
        })[0]?.[0];

    if (!bestCountry) return null;

    const bestAdmin = bestAdminFor(bestCountry);

    const filtered = groups.flat().filter(c =>
        c.country === bestCountry &&
        (!bestAdmin || `${c.country}|${c.admin1_name}` === bestAdmin[0])
    );

    if (!filtered.length) return null;

    // centroid
    const lat = filtered.reduce((s, c) => s + c.lat, 0) / filtered.length;
    const lon = filtered.reduce((s, c) => s + c.lon, 0) / filtered.length;

    return {
        country: bestCountry,
        admin1: bestAdmin ? bestAdmin[0].split("|")[1] : null,
        lat,
        lon,
        inferred: true   // a guess, not something the user or the page told us
    };
}


// -----------------------------
// Convert city from message to context for bias
// -----------------------------
function cityHintToContext(cityText) {
    if (!cityText || !cityIndex) return null;

    // "Roanoke, Virginia"
    const parts = cityText.split(",").map(p => normalize(p.trim()));
    if (parts.length < 2) return null;

    const city = parts[0];
    const admin = parts[1];

    const candidates = cityIndex.get(city);
    if (!candidates) return null;

    // Prefer matching admin1 name
    const filtered = candidates.filter(c =>
        normalize(c.admin1_name) === admin
    );

    const chosen = filtered[0] || candidates[0];
    if (!chosen) return null;

    return {
        country: chosen.country,
        admin1: chosen.admin1_name,
        lat: chosen.lat,
        lon: chosen.lon
    };
}



// -----------------------------
// Return context received just if it has data in it
// -----------------------------
function isStrongContext(ctx) {
    return !!(ctx && ctx.lat && ctx.lon);
}


// -----------------------------
// Merge and geocode listings (ONCE)
// -----------------------------
let droppedByRegion = 0;

function mergeListings(newListings, incomingContext) {
    for (const l of newListings) {
        // Skip duplicates
        if (addedItems.has(l.image)) {
            if (jitterCache.has(l.url)) {
                const { jLat, jLon } = jitterCache.get(l.url);
                l.jLat = jLat;
                l.jLon = jLon;
            }
            continue;
        }
        addedItems.add(l.image);

        // Collect context samples
        if (!homeContext && !searchContext && !isStrongContext(incomingContext)) {
            collectContextSample(l.location);
            if (contextSamples.length >= CONTEXT_SAMPLE_LIMIT) {
                searchContext = inferContext(contextSamples);
                contextSamples.length = 0;
                regeocodeExisting(searchContext);
            }
        }

        // A region the user set by hand always wins
        const contextToUse = homeContext
            || (isStrongContext(incomingContext) ? incomingContext : searchContext);

        const place = geocodeOffline(l.location || "", contextToUse);

        if (!place) continue; // skip if geocoding failed

        // Country lock — only when we actually know where the user is. When the
        // country was merely inferred from place names, a wrong guess used to
        // delete every listing that disagreed with it, so a Quebec search lost
        // the cities that have no European namesake and kept the ones that do.
        const authoritative = contextToUse && !contextToUse.inferred;
        if (authoritative && contextToUse.country && place.country !== contextToUse.country) {
            droppedByRegion++;
            continue;
        }

        // jitter coords
        let jLat, jLon;
        if (jitterCache.has(l.url)) {
            ({ jLat, jLon } = jitterCache.get(l.url));
        } else {
            [jLat, jLon] = jitter(place.lat, place.lon, 2000);
            jitterCache.set(l.url, { jLat, jLon });
        }
        l.jLat = jLat;
        l.jLon = jLon;

        globalListings.push(l);
    }
}




// -----------------------------
// DOM Ready
// -----------------------------
document.addEventListener("DOMContentLoaded", () => {
    const mapDiv = document.getElementById("mkp-mapper-map");
    mapDiv.style.width = "100%";
    mapDiv.style.height = "100%";

    startVisit();

    initMap().then(() => {
        setTimeout(() => map.invalidateSize(), 200);
        setupAreaDrawing();
    });

    setupTools();

    // Tell content.js we are listening. Its first scrape runs before this frame
    // exists, so that batch lands nowhere; without this we would sit idle until
    // the next two-second tick.
    parent.postMessage({ type: "map-listening" }, "*");
});

// History is only worth writing once things settle, not on every scrape tick
setInterval(saveHistory, 5000);
window.addEventListener("pagehide", saveHistory);


// -----------------------------
// Receive listings
// -----------------------------
window.addEventListener("message", (event) => {
    if (event.data.source !== "marketplace-mapper") return;

    // Auto-load sweep progress (no listings in these messages)
    if (event.data.type === "autoscroll-status") {
        setAutoloadSpinner(event.data.running, event.data.progress);
        return;
    }

    // Scraper health (no listings in these messages)
    if (event.data.type === "scrape-health") {
        setScrapeHealth(event.data.status);
        return;
    }

    // The city database is ~12MB, so the first batch of listings can easily
    // arrive before it is ready. Geocoding them now would silently drop every
    // one and leave the panel hidden until the next scrape two seconds later,
    // so hold the batch and replay it once the database lands.
    if (!cityIndex || !map) {
        pendingListings = event.data;
        return;
    }

    const itemView = isItemView(event.data);

    // Item view: add item marker if missing, open popup once, then ignore subsequent messages
    if (itemView) {
        const itemKey = extractMarketplaceItemKey(event.data.url);

        if (!markerByItemKey.has(itemKey)) {
            mergeListings(event.data.listings, event.data.context);
            for (const l of globalListings) {
                if (l._rendered) continue;
                addMarkerToMap(l);
                l._rendered = true;
                if (!initialLocationSet && l.jLat && l.jLon) {
                    initialLocationSet = true;
                    map.setView([l.jLat, l.jLon], 11);
                    document.getElementById("map-loading")?.remove();
                    announceMapReady();
                }
            }
        }

        if (itemKey !== lastOpenedItemKey && markerByItemKey.has(itemKey)) {
            lastOpenedItemKey = itemKey;
            openListingOnMapByUrl(event.data.url);
        }
        return;
    }

    // Leaving item view
    lastOpenedItemKey = null;

    const newSearch = isNewSearch(event.data);

    if (newSearch) {
        searchContext = null;
        contextSamples = [];
        addedItems.clear();
        globalListings = [];
        jitterCache.clear();
        clearMapMarkers();
        initialLocationSet = null;
    }

    // Try seeding context from city hint (once per search)
    if (!searchContext && event.data.city) {
        const seeded = cityHintToContext(event.data.city);
        if (seeded) {
            searchContext = seeded;
            lockedAdmin1 = normalize(seeded.admin1);
        }
    }

    lastIncomingContext = event.data.context;
    mergeListings(event.data.listings, event.data.context);

    // render only new ones
    for (const l of globalListings) {
        if (l._rendered) continue;
        addMarkerToMap(l);
        l._rendered = true;

        // first marker sets initial view
        if (!initialLocationSet) {
            const ctx = isStrongContext(lastIncomingContext) ? lastIncomingContext : searchContext;
            const viewLat = ctx?.lat || l.jLat;
            const viewLon = ctx?.lon || l.jLon;

            if (viewLat && viewLon) {
                initialLocationSet = true;
                map.setView([viewLat, viewLon], 11);
                document.getElementById("map-loading")?.remove();
                announceMapReady();
            }
        }
    }

    updateNewBadge();
    updateAreaHint();
    updateRegionWarning();
});

// Show how many new listings this visit turned up, so the feature is visible
// before anyone thinks to click the filter.
function updateNewBadge() {
    const btn = document.getElementById("mkp-tool-new");
    if (!btn) return;

    const count = markers.filter(m => isNewListing(m.itemKey)).length;
    btn.dataset.count = count > 99 ? "99+" : String(count);
    btn.classList.toggle("has-new", count > 0);
    btn.dataset.tooltip = count > 0
        ? `${count} new since your last visit. Click to show only these`
        : "Show only listings new since your last visit";
}
