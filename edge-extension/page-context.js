// Runs in the MAIN world (see manifest "world": "MAIN").
//
// content.js runs in an isolated world, where page globals like
// __PRELOADED_STATE__ are simply not visible — reading it there always yields
// undefined, so the map's location context has silently been empty. This script
// runs in the page's own world, reads the state, and hands it across with
// postMessage. If anything here fails, content.js keeps its previous behaviour.
(function () {
  "use strict";

  const MAX_TRIES = 20;
  const NODE_BUDGET = 3000;   // cap the deep scan on a very large state object

  function toContext(loc) {
    const lat = loc.latitude ?? loc.lat ?? null;
    const lon = loc.longitude ?? loc.lon ?? loc.lng ?? null;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const rg = loc.reverse_geocode || loc.reverseGeocode || loc.geocode || {};
    return {
      lat,
      lon,
      country: rg.country || rg.countryCode || null,
      admin1: rg.state || rg.province || rg.region || null
    };
  }

  // Paths Facebook has used over time
  function fromKnownPaths(state) {
    const candidates = [
      state.marketplace?.user_current_location,
      state.marketplace?.saved_searches_location,
      state.marketplace?.marketplaceUserCurrentLocation,
      state.marketplaceUserCurrentLocation,
      state.marketplace?.location,
      state.currentLocation
    ];

    for (const c of candidates) {
      if (!c) continue;
      const ctx = toContext(c);
      if (ctx) return ctx;
    }
    return null;
  }

  // Fallback: breadth-first hunt for any object carrying a lat/lon pair.
  // Bounded so a huge state tree can't stall the page.
  function fromDeepScan(state) {
    const seen = new Set();
    const queue = [state];
    let visited = 0;

    while (queue.length && visited < NODE_BUDGET) {
      const node = queue.shift();
      visited++;

      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);

      const ctx = toContext(node);
      if (ctx) return ctx;

      for (const key in node) {
        try {
          const val = node[key];
          if (val && typeof val === "object") queue.push(val);
        } catch { /* getters can throw */ }
      }
    }
    return null;
  }

  function read() {
    try {
      const state = window.__PRELOADED_STATE__;
      if (!state || typeof state !== "object") return null;
      return fromKnownPaths(state) || fromDeepScan(state);
    } catch {
      return null;
    }
  }

  let lastContext = null;

  function publish() {
    const context = read() || lastContext;
    if (!context) return false;

    lastContext = context;
    window.postMessage({ source: "mkpm-page-context", context }, window.location.origin);
    return true;
  }

  // This script runs at document_start but content.js runs at document_idle, so
  // a single publish can land before anyone is listening. Answer on demand as
  // well, and repeat a few times rather than stopping at the first success.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "mkpm-page-context-request") return;
    publish();
  });

  let tries = 0;
  let published = 0;

  publish() && published++;

  const timer = setInterval(() => {
    if (publish()) published++;
    if (published >= 3 || ++tries >= MAX_TRIES) clearInterval(timer);
  }, 1000);
})();
