let map;
let markerLayerGroup = null;
let markers = [];
let markerByItemKey = new Map(); // itemKey -> marker
let cityIndex = null;
let lockedAdmin1 = null; // soft lock for inferring listings within the same admin1 first

let addedItems = new Set();         // Image URLs of markers already added
let globalListings = [];            // merged listings
let lastSearchSignature = null;     // for new-search detection
let initialLocationSet = null;
let jitterCache = new Map();   // url -> { jLat, jLon }

let searchContext = null;
let contextSamples = [];
let lastIncomingContext = null;
const CONTEXT_SAMPLE_LIMIT = 7;

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
    const url = chrome.runtime.getURL("data/cities_db.json");
    const res = await fetch(url);
    const buf = await res.arrayBuffer();

    let arr = JSON.parse(new TextDecoder().decode(
        new Uint8Array(buf)
    ));

    // If arr is an object (dictionary), convert to array of city objects
    if (!Array.isArray(arr)) {
        arr = Object.values(arr);   // <-- this is the key
    }

    cityIndex = new Map();

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
function geocodeOffline(text, context = null) {
    if (!cityIndex || !text) return null;

    const parts = text.split(",").map(x => x.trim());
    const cityPart = normalize(parts[0]);
    const adminPart = parts[1] ? normalize(parts[1]) : null;

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
        if (listingAdmin) {
            if (cAdmin.startsWith(listingAdmin)) {
                score += 300;
            } else {
                score -= 200;
            }
        }

        /* ----------------------------------
         Search intent (soft lock / context)
           Only if listing did NOT specify admin
        ---------------------------------- */
        if (!listingAdmin) {
            if (lockedAdmin1) {
                if (cAdmin === lockedAdmin1) score += 120;
                else score -= 40;
            }

            if (ctxAdmin && cAdmin === ctxAdmin) {
                score += 100;
            }
        }

        /* ----------------------------------
           Country
        ---------------------------------- */
        if (context?.country &&
            normalize(c.country) === normalize(context.country)) {
            score += 60;
        }

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

    map = L.map("mkp-mapper-map");

    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);

    markerLayerGroup = L.layerGroup().addTo(map);

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
    let popupHtml = `
        <div style="display: flex; flex-direction: column; margin: 0 .5rem .5rem;">
            <p style="margin: 0; font-size: .9rem; font-weight: bold;">${parsePrice(listing.price)}<p>
            <p style="margin: 0;">${listing.title}</p>
            <p style="margin: 0 0 .3rem 0; font-size: .8rem; color: #858585;">${listing.location}</p>
            <a href="${listing.url}" target="_blank">Open Listing</a>
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

    const marker = L.marker([listing.jLat, listing.jLon])
        .addTo(markerLayerGroup)
        .bindPopup(popupHtml)
        .bindTooltip(tooltipHtml);

    markers.push(marker);

    const itemKey = extractMarketplaceItemKey(listing.url);
    if (itemKey) markerByItemKey.set(itemKey, marker);
}


// -----------------------------
// Helper for collecting candidate cities per listing
// -----------------------------
function collectContextSample(locationText) {
    if (!locationText) return;

    const cityKey = normalize(locationText.split(",")[0]);
    const candidates = cityIndex.get(cityKey);
    if (!candidates) return;

    contextSamples.push(...candidates);
}


// -----------------------------
// Infer the most likely context for init location
// -----------------------------
function inferContext(candidates) {
    const countryCount = new Map();
    const adminCount = new Map();

    for (const c of candidates) {
        countryCount.set(c.country, (countryCount.get(c.country) || 0) + 1);
        if (c.admin1_name) {
            const key = `${c.country}|${c.admin1_name}`;
            adminCount.set(key, (adminCount.get(key) || 0) + 1);
        }
    }

    const bestCountry = [...countryCount.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0];

    const bestAdmin = [...adminCount.entries()]
        .filter(([k]) => k.startsWith(bestCountry + "|"))
        .sort((a, b) => b[1] - a[1])[0];

    const filtered = candidates.filter(c =>
        c.country === bestCountry &&
        (!bestAdmin || `${c.country}|${c.admin1_name}` === bestAdmin[0])
    );

    // centroid
    const lat = filtered.reduce((s, c) => s + c.lat, 0) / filtered.length;
    const lon = filtered.reduce((s, c) => s + c.lon, 0) / filtered.length;

    return {
        country: bestCountry,
        admin1: bestAdmin ? bestAdmin[0].split("|")[1] : null,
        lat,
        lon
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
        if (!searchContext && !isStrongContext(incomingContext)) {
            collectContextSample(l.location);
            if (contextSamples.length >= CONTEXT_SAMPLE_LIMIT) {
                searchContext = inferContext(contextSamples);
                contextSamples.length = 0;
            }
        }

        const contextToUse = isStrongContext(incomingContext) ? incomingContext : searchContext;
        const place = geocodeOffline(l.location || "", contextToUse);

        if (!place) continue; // skip if geocoding failed

        // Country lock: skip listings outside inferred country
        if (contextToUse?.country && place.country !== contextToUse.country) {
            // console.log("Skipping listing outside country:", l.location, place.country);
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

    initMap().then(() => {
        setTimeout(() => map.invalidateSize(), 200);
    });
});


// -----------------------------
// Receive listings
// -----------------------------
window.addEventListener("message", (event) => {
    if (event.data.source !== "marketplace-mapper") return;

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
                const overlay = document.getElementById("map-loading");
                if (overlay) overlay.remove();
            }
        }
    }

    // Open lising popup if navigating item URL
    openListingOnMapByUrl(event.data.url);
});
