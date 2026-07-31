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
        hint.textContent = `${shown} listing${shown === 1 ? "" : "s"} in your area — click the area tool to clear`;
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
            pricePanel.style.display = pricePanel.style.display === "block" ? "none" : "block";
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
            });
        }
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
        ? "Listings are visible but can't be read — Facebook may have changed their layout."
        : "No listings found on this page. If you can see listings, the extension may need an update.";

    const subject = encodeURIComponent(`Marketplace Map — scraping issue (${status})`);
    el.innerHTML = `<span>${msg}</span>
        <a href="mailto:guille.sotelo.cloud@gmail.com?subject=${subject}" target="_blank">Report</a>`;
    el.style.display = "flex";
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

    startVisit();

    initMap().then(() => {
        setTimeout(() => map.invalidateSize(), 200);
        setupAreaDrawing();
    });

    setupTools();
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
            }
        }
    }

    updateNewBadge();
    updateAreaHint();
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
        ? `${count} new since your last visit — click to show only these`
        : "Show only listings new since your last visit";
}
