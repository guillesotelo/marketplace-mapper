let map;
let markerLayerGroup = null;
let markers = [];
let cityIndex = null;

let addedLinks = new Set();         // URLs of markers already added
let globalListings = [];            // merged listings
let lastSearchSignature = null;     // for new-search detection
let initialLocation = null;
let jitterCache = new Map();   // url -> { jLat, jLon }


// -----------------------------
// Detect new search
// -----------------------------
function isNewSearch(data) {
    const signature = data.url;
    if (!signature.includes('/item/') && signature !== lastSearchSignature) {
        lastSearchSignature = signature;
        return true;
    }
    return false;
}


// -----------------------------
// Load City DB
// -----------------------------
async function loadCityDB() {
    const url = chrome.runtime.getURL("data/cities_db.json.gz");
    const res = await fetch(url);
    const buf = await res.arrayBuffer();

    let arr = JSON.parse(new TextDecoder().decode(
        pako.ungzip(new Uint8Array(buf))
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

    const candidates = cityIndex.get(cityPart) || [];

    if (!candidates.length) return null;

    // Score candidates
    let best = null;
    let bestScore = -Infinity;

    for (const c of candidates) {
        let score = 0;

        // 1. Exact country match (or context bias)
        if (context?.country && normalize(c.country) === normalize(context.country)) score += 100;

        // 2. Admin1 match (or context)
        if (adminPart && normalize(c.admin1_name) === adminPart) score += 50;
        if (context?.admin1 && normalize(c.admin1_name) === normalize(context.admin1)) score += 50;

        // 3. Fallback: closer to context coordinates
        if (context?.lat && context?.lon) {
            const dLat = c.lat - context.lat;
            const dLon = c.lon - context.lon;
            const dist = Math.sqrt(dLat * dLat + dLon * dLon);
            score -= dist * 100; // closer is better
        }

        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best || candidates[0];
}


// -----------------------------
// Jitter coords
// -----------------------------
function jitter(lat, lon, meters = 1500) {
    const latOffset = (Math.random() - 0.5) * (meters / 111000);
    const lonOffset = (Math.random() - 0.5) * (meters / (111000 * Math.cos(lat * Math.PI / 180)));
    return [lat + latOffset, lon + lonOffset];
}


// -----------------------------
// Create map + layer
// -----------------------------
async function initMap() {
    await loadCityDB();

    map = L.map("mkp-mapper-map");

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
    }).addTo(map);

    markerLayerGroup = L.layerGroup().addTo(map);
}


// -----------------------------
// Clear markers
// -----------------------------
function clearMapMarkers() {
    if (markerLayerGroup) markerLayerGroup.clearLayers();
    markers = [];
}


// -----------------------------
// Add one marker
// -----------------------------
function addMarkerToMap(listing) {
    if (!listing.jLat || !listing.jLon) return;
    let popupHtml = `
        <b>${listing.title}</b>
        <br>${listing.location}<br>
        <a href="${listing.url}" target="_blank">Open</a>
        `;
    if (listing.image) {
        popupHtml = `<img src="${listing.image}" style="width:100px;height:auto;"><br>` + popupHtml;
    }

    const marker = L.marker([listing.jLat, listing.jLon])
        .addTo(markerLayerGroup)
        .bindPopup(popupHtml);

    markers.push(marker);
}


// -----------------------------
// Merge and geocode listings (ONCE)
// -----------------------------
function mergeListings(newListings, context) {
    for (const l of newListings) {

        // Skip duplicates based on URL
        if (addedLinks.has(l.url)) {
            // But restore cached jitter on repeated listings
            if (jitterCache.has(l.url)) {
                const { jLat, jLon } = jitterCache.get(l.url);
                l.jLat = jLat;
                l.jLon = jLon;
            }
            continue;
        }

        addedLinks.add(l.url);

        // Geocode once
        const place = geocodeOffline(l.location || "", context);

        if (place) {
            let jLat, jLon;

            // If jitter was used before → reuse same jitter
            if (jitterCache.has(l.url)) {
                ({ jLat, jLon } = jitterCache.get(l.url));
            } else {
                // First time → randomize + store
                [jLat, jLon] = jitter(place.lat, place.lon, 2000);
                jitterCache.set(l.url, { jLat, jLon });
            }

            l.jLat = jLat;
            l.jLon = jLon;
        }

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
        addedLinks.clear();
        globalListings = [];
        jitterCache.clear();
        clearMapMarkers();
        initialLocation = null;
    }

    mergeListings(event.data.listings, event.data.context);

    // render only new ones
    for (const l of globalListings) {
        if (l._rendered) continue;
        addMarkerToMap(l);
        l._rendered = true;

        // first marker sets initial view
        if (!initialLocation && l.jLat) {
            initialLocation = true;
            map.setView([l.jLat, l.jLon], 11);

            const overlay = document.getElementById("map-loading");
            if (overlay) overlay.remove();
        }
    }
});
