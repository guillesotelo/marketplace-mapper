let map;
let markerLayer;
let cityIndex = null;
let initialLocation = null;
let listings = null;
let addedLinks = [];

// Load city DB
async function loadCityDB() {
    const url = chrome.runtime.getURL("data/packed.json.gz");
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const jsonText = new TextDecoder().decode(pako.ungzip(new Uint8Array(buf)));
    const arr = JSON.parse(jsonText);

    cityIndex = new Map();
    for (const [name, lat, lon] of arr) {
        cityIndex.set(name.toLowerCase(), { name, lat, lon });
    }
    // console.log("City DB loaded:", cityIndex.size);
}

// Normalize text for matching
function normalize(text) {
    if (!text) return '';
    // lowercase, trim, remove trailing letter codes like ", M"
    return text.toLowerCase().trim().replace(/,[ ]?[A-Z]$/, '').normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

// Offline geocode
function geocodeOffline(text) {
    if (!cityIndex) return null;
    if (!text) return null;

    // Normalize
    const norm = text.trim();
    const parts = norm.split(",").map(s => s.trim());

    const cityPart = parts[0].toLowerCase();
    const provincePart = parts[1]?.toUpperCase() || null;

    // Look for exact match: city + province
    for (const [k, v] of cityIndex) {
        if (v.name.toLowerCase() === cityPart) {
            if (!provincePart || v.admin1 === provincePart) {
                return v;
            }
        }
    }

    // fallback: city only
    for (const [k, v] of cityIndex) {
        if (v.name.toLowerCase() === cityPart) return v;
    }

    return null;
}

function jitter(lat, lon, meters = 100) {
    // Convert meters to degrees (~1 deg latitude ≈ 111 km)
    const latOffset = (Math.random() - 0.5) * (meters / 111000);
    const lonOffset = (Math.random() - 0.5) * (meters / (111000 * Math.cos(lat * Math.PI / 180)));
    return [lat + latOffset, lon + lonOffset];
}

function getMergedListings(newListings) {
    currentListings = listings || []
    const merged = []
    const mergedLinks = currentListings.map(l => `${l.url}`)

    currentListings.concat(newListings).forEach(l => {
        if (!mergedLinks.includes(l.url)) {
            const place = geocodeOffline(l.location || l.title.split("\n").pop());
            const [jLat, jLon] = place ? jitter(place.lat, place.lon, 2000) : [null, null]

            const newListing = l.jLat ? l : { ...l, jLat, jLon }

            merged.push(newListing)
        }
    })

    listings = merged
    return merged
}


// Update map with listings
function updateMap(newListings) {
    if (!map || !cityIndex) return;
    // markerLayer.clearLayers();

    getMergedListings(newListings).forEach((item, index) => {
        const place = geocodeOffline(item.location || item.title.split("\n").pop());
        if (!place || addedLinks.includes(item.url) || !item.jLat || !item.jLon) return;

        addedLinks.push(item.url)

        const marker = L.marker([item.jLat, item.jLon]).addTo(markerLayer);

        // Include image in popup if available
        let popupHtml = `<b>${item.title}</b><br>${item.location}<br><a href="${item.url}" target="_blank">Open</a>`;
        if (item.image) {
            popupHtml = `<img src="${item.image}" style="width:100px;height:auto;"><br>` + popupHtml;
        }
        marker.bindPopup(popupHtml);

        if (index === 0 && !initialLocation) {
            initialLocation = place
            map.setView([place.lat, place.lon], 12);
        }

    });
}

// Initialize Leaflet map
async function initMap() {
    await loadCityDB();

    map = L.map("mkp-mapper-map").setView([57.7089, 11.9746], 11);
    markerLayer = L.layerGroup().addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        subdomains: ["a", "b", "c"],
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    // console.log("Map ready");
}

document.addEventListener("DOMContentLoaded", () => {
    const mapDiv = document.getElementById("mkp-mapper-map");
    mapDiv.style.width = "100%";
    mapDiv.style.height = "100%";
    initMap();

    setTimeout(() => {
        map.invalidateSize();
    }, 200);
});

// Listen for listings from content.js
window.addEventListener("message", (event) => {
    if (event.data.source === "marketplace-mapper") {
        updateMap(event.data.listings);
    }
});