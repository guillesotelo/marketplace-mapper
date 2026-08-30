let lastUrl = location.href;
let mapClosed = false;
let lastCity = null;
let scheduled = false;
const iframeHeight = '520px'

// What the results grid told us about each item (key -> { location, price, ... }).
// Item pages are much harder to read than the cards that link to them, so we
// keep the card's version around for when the user opens one.
const itemFactsCache = new Map();
const ITEM_FACTS_LIMIT = 600;

function itemKeyFromUrl(url) {
  const m = String(url || "").match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}

// Location context handed over by page-context.js, which runs in the MAIN world
// because __PRELOADED_STATE__ isn't reachable from this isolated one.
let pageContext = null;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "mkpm-page-context") return;

  const ctx = event.data.context;
  if (ctx && typeof ctx.lat === "number" && typeof ctx.lon === "number") {
    pageContext = ctx;
  }
});

// The bridge may have published before this script was listening
window.postMessage({ source: "mkpm-page-context-request" }, "*");

function getMarketplaceCity() {
  const el = document.querySelector('#seo_filters span[dir="auto"]');
  if (!el) return null;
  return (el.innerText || el.textContent)?.match(/^[^·]+/)?.[0].trim() ?? null;
}


const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;

  requestAnimationFrame(() => {
    scheduled = false;

    // Route change detection
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onRouteChange();
    }

    // City detection (currently not used)
    if (location.pathname.startsWith('/marketplace')) {
      const city = getMarketplaceCity();
      if (city && city !== lastCity) {
        lastCity = city;
      }
    }
  });
});

observer.observe(document, { subtree: true, childList: true });

function onRouteChange() {
  // A sweep belongs to the page it started on
  cancelAutoScrollSweep(false);

  // Health is judged per page
  healthBadTicks = 0;
  lastHealthStatus = null;

  if (location.pathname.startsWith("/marketplace") && !mapClosed) {
    injectMap();
    // New results page: sweep it too, that's what "auto" means
    if (autoScrollEnabled && !location.href.includes('/item/')) {
      setTimeout(runAutoScrollSweep, 1200);
    }
  }
}

// -----------------------------
// Auto-load listings (feature-flagged; enabled by the UI toggle)
//
// Marketplace lazy-loads listings only as the main page scrolls into view.
// This does a one-time downward sweep to force more listings into the DOM so
// the 2s scraper can capture them (the map accumulates + dedupes), then
// restores the original scroll position. Disabled by default.
// -----------------------------
let autoScrollRunning = false;
let autoScrollEnabled = false;   // the UI toggle state
let autoScrollCancel = null;     // set while a sweep is in flight

// Hard ceiling on a sweep. The user is stuck watching the page scroll, so it
// has to end on its own even if Marketplace keeps feeding us more results.
const SWEEP_MAX_MS = 5000;
const SWEEP_MAX_STEPS = 40;

function notifyAutoScrollStatus(running, progress = 0) {
  const iframe = document.getElementById("mkp-mapper-frame");
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({
      source: "marketplace-mapper",
      type: "autoscroll-status",
      running,
      progress
    }, "*");
  }
}

// -----------------------------
// Silent-failure detector
//
// Everything here is scraped from Facebook's markup, so a redesign on their
// side makes the map quietly go blank — users see an empty map and uninstall
// without ever reporting it. Watch for "we should be seeing listings but
// aren't" and surface it in the map instead of failing silently.
// -----------------------------
const HEALTH_GRACE_TICKS = 8;   // ~16s at the 2s scrape cadence
let healthBadTicks = 0;
let lastHealthStatus = null;

function computeScrapeHealth(listings) {
  const onResults = location.pathname.startsWith("/marketplace")
    && !location.href.includes("/item/");

  // Only results pages are expected to show listings
  if (!onResults) { healthBadTicks = 0; return "ok"; }

  // Page hasn't rendered yet — no verdict either way
  if ((document.body?.innerText || "").length < 500) { healthBadTicks = 0; return "ok"; }

  const anchors = document.querySelectorAll("a[href*='/marketplace/item/']").length;

  let problem = null;
  if (anchors === 0) {
    // Either Facebook changed their markup or this search genuinely has no
    // results — the banner wording covers both.
    problem = "no-listings";
  } else if (listings.length) {
    // Cards are visible but we can't read them: parsing has drifted
    const usable = listings.filter(l => l.location && l.price).length;
    if (usable / listings.length < 0.2) problem = "unparsed";
  }

  if (!problem) { healthBadTicks = 0; return "ok"; }

  healthBadTicks++;
  return healthBadTicks >= HEALTH_GRACE_TICKS ? problem : "ok";
}

function reportScrapeHealth(listings) {
  const status = computeScrapeHealth(listings);
  if (status === lastHealthStatus) return;   // only post on change
  lastHealthStatus = status;

  const iframe = document.getElementById("mkp-mapper-frame");
  iframe?.contentWindow?.postMessage({
    source: "marketplace-mapper",
    type: "scrape-health",
    status
  }, "*");
}

// Stop an in-flight sweep. `restore` returns the page to where the sweep
// started — we skip it when the user took over scrolling themselves.
function cancelAutoScrollSweep(restore) {
  if (autoScrollCancel) autoScrollCancel(restore);
}

// Interruptible sleep: resolves early (as false) when the sweep is cancelled.
function sweepSleep(ms, token) {
  return new Promise(resolve => {
    if (token.cancelled) return resolve(false);
    const timer = setTimeout(() => {
      token.onCancel = null;
      resolve(!token.cancelled);
    }, ms);
    token.onCancel = () => {
      clearTimeout(timer);
      token.onCancel = null;
      resolve(false);
    };
  });
}

// Wait for lazy-loaded content to extend the page, up to timeoutMs
async function waitForPageGrowth(prevHeight, token, timeoutMs = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!await sweepSleep(250, token)) return false;
    if (document.body.scrollHeight > prevHeight + 10) return true;
  }
  return false;
}

async function runAutoScrollSweep() {
  if (autoScrollRunning) return;
  // Skip on item view — auto-scrolling a single listing page is just annoying
  if (location.href.includes('/item/')) return;
  autoScrollRunning = true;

  const startY = window.scrollY;
  const startedAt = Date.now();
  const step = window.innerHeight * 0.9;
  const settleMs = 400;

  const token = { cancelled: false, onCancel: null };
  let restoreScroll = true;

  // Any scroll gesture from the user wins: they want to look at something,
  // not fight the sweep. Leave them where they are and bail out.
  const onUserScroll = () => cancelAutoScrollSweep(false);
  const onUserKey = (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
      cancelAutoScrollSweep(false);
    }
  };

  autoScrollCancel = (restore) => {
    if (token.cancelled) return;
    token.cancelled = true;
    restoreScroll = !!restore;
    if (token.onCancel) token.onCancel();
  };

  window.addEventListener("wheel", onUserScroll, { passive: true });
  window.addEventListener("touchmove", onUserScroll, { passive: true });
  window.addEventListener("keydown", onUserKey, true);

  notifyAutoScrollStatus(true, 0);
  try {
    for (let i = 0; i < SWEEP_MAX_STEPS; i++) {
      if (token.cancelled) break;

      // Time cap wins over step count — a slow-loading page shouldn't be able
      // to stretch the sweep out indefinitely.
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SWEEP_MAX_MS) break;

      window.scrollBy(0, step);
      if (!await sweepSleep(settleMs, token)) break;

      notifyAutoScrollStatus(true, Math.min(
        1,
        Math.max((i + 1) / SWEEP_MAX_STEPS, (Date.now() - startedAt) / SWEEP_MAX_MS)
      ));

      // At the loading edge, give Marketplace a moment to append more listings
      // before concluding we've reached the true end of results.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 5) {
        const grew = await waitForPageGrowth(document.body.scrollHeight, token);
        if (!grew) break;
      }
    }
  } finally {
    window.removeEventListener("wheel", onUserScroll);
    window.removeEventListener("touchmove", onUserScroll);
    window.removeEventListener("keydown", onUserKey, true);

    if (restoreScroll) window.scrollTo({ top: startY, behavior: "auto" });
    autoScrollCancel = null;
    autoScrollRunning = false;
    notifyAutoScrollStatus(false, 0);
  }
}

function injectMap() {

  // Inject iframe only once
  if (!document.getElementById("mkp-mapper-frame")) {
    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("map.html");
    iframe.id = "mkp-mapper-frame";

    Object.assign(iframe.style, {
      position: "fixed",
      top: "80px",
      right: "20px",
      width: "420px",
      height: iframeHeight,
      zIndex: 999999,
      border: "1px solid #354c80",
      background: "#354c80",
      borderRadius: "8px",
      transition: '.4s',
      opacity: 0,
    });

    // Listen for drag messages from the header
    let dragOverlay = null;
    let offsetX = 0;
    let offsetY = 0;
    let onMouseMove = null;
    let onMouseUp = null;

    window.addEventListener("message", (event) => {
      if (!iframe || event.source !== iframe.contentWindow) return;

      if (event.data.type === "drag-start") {
        iframe.style.transition = 'none'
        offsetX = event.data.offsetX;
        offsetY = event.data.offsetY;

        // Create overlay to capture events
        dragOverlay = document.createElement("div");
        Object.assign(dragOverlay.style, {
          position: "fixed",
          top: "0",
          left: "0",
          width: "100vw",
          height: "100vh",
          zIndex: 9999999,
          background: "transparent",
          cursor: "grabbing"
        });
        document.body.appendChild(dragOverlay);

        iframe.style.zIndex = 9999998;

        onMouseMove = (eMove) => {
          const top = eMove.clientY - offsetY + "px";
          const left = eMove.clientX - offsetX + "px";
          iframe.style.top = top
          iframe.style.left = left

          iframe.contentWindow.postMessage({
            type: "save-position",
            top,
            left
          }, "*");
        };

        onMouseUp = () => {
          iframe.style.transition = '.4s'
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          if (dragOverlay) {
            dragOverlay.remove();
            dragOverlay = null;
          }
        };

        dragOverlay.addEventListener("mousemove", onMouseMove);
        dragOverlay.addEventListener("mouseup", onMouseUp);
      }

      else if (event.data.type === "drag-end") {
        // Explicit drag-end message from iframe
        if (dragOverlay && onMouseMove && onMouseUp) {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          dragOverlay.remove();
          dragOverlay = null;
          iframe.style.transition = '.4s'
        }
      }

      else if (event.data.type === "load-position") {
        iframe.style.top = event.data.top
        iframe.style.left = event.data.left
      }

      else if (event.data.type === "close-map") {
        mapClosed = true
        iframe.remove()
      }

      else if (event.data.type === "minimize-map") {
        const newHeight = event.data.height || iframeHeight
        iframe.style.height = newHeight
      }

      else if (event.data.type === "toggle-autoscroll") {
        // Feature-flagged: only sweeps when the UI toggle is enabled
        autoScrollEnabled = !!event.data.enabled;
        if (autoScrollEnabled) runAutoScrollSweep();
        else cancelAutoScrollSweep(true);
      }
    });

    document.body.appendChild(iframe);

    // Reveal when the map reports it has placed its first listing, rather than
    // after a fixed wait. The timeout stays as a backstop: a search with no
    // results never places a marker, and the panel still has to appear so its
    // banners and controls are reachable.
    const revealMap = () => {
      if (iframe.style.opacity === "1") return;
      iframe.style.opacity = 1;
    };

    window.addEventListener("message", (event) => {
      if (event.source !== iframe.contentWindow) return;
      if (event.data?.type === "map-ready") revealMap();

      // The frame is up and listening: send it what we can see right now
      if (event.data?.type === "map-listening") scrapeTick();
    });

    setTimeout(revealMap, 4000);
  }

  function normalize(text) {
    return text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
  }

  const FREE_WORDS = [
    // English / Germanic
    "free", "gratis", "kostenlos",

    // Romance
    "gratuit", "gratuito", "gratuita",

    // Slavic
    "za darmo", "besplatno",

    // Finnish / Hungarian
    "ilmainen", "ingyenes",

    // Russian
    "бесплатно",

    // Indian languages
    "मुफ्त",      // Hindi
    "ఉచితం",     // Telugu
    "উপহার"      // Bengali
  ];

  const BADGE_WORDS = [
    // English
    "just listed", "new listing", "newly listed",

    // Scandinavian
    "ny", "nettopp lagt ut", "nylig lagt ut",

    // German / Dutch
    "neu", "gerade eingestellt",

    // Romance
    "nouvelle annonce", "recién publicado",

    // Slavic
    "nowe ogłoszenie", "nový inzerát",

    // Finnish
    "juuri lisätty",

    // Russian
    "только что размещено", "новое объявление"
  ];

  const CURRENCY_MARKERS = [
    // Symbols
    "$", "€", "£", "₹", "₽",

    // Text / ISO
    "usd", "eur", "gbp",
    "inr", "rs", "rub",

    // Nordic
    "kr", "sek", "nok", "dkk"
  ];

  function isFree(text) {
    const t = normalize(text);
    return FREE_WORDS.some(w => t === w || t.startsWith(w + " "));
  }

  function isBadge(text) {
    return BADGE_WORDS.includes(normalize(text));
  }

  function hasCurrencyNearNumber(text) {
    return /(\p{Sc}\s?\d|\d\s?\p{Sc})/u.test(text);
  }

  function isPrice(text) {
    const t = normalize(text);

    if (isFree(t)) return true;

    const hasNumber = /\d/.test(t);
    const hasCurrency =
      hasCurrencyNearNumber(t) ||
      CURRENCY_MARKERS.some(c => t.includes(c));

    return hasNumber && hasCurrency;
  }

  function parseLines(lines) {
    let price = null;
    let badge = "";
    let title = "";
    let location = "";

    let working = [...lines];

    // Badge (strict match only)
    if (working.length && isBadge(working[0])) {
      badge = working.shift();
    }

    // Price (anywhere)
    const priceIndex = working.findIndex(isPrice);
    if (priceIndex !== -1) {
      price = working[priceIndex];
      working.splice(priceIndex, 1);
    }

    // Remaining: title + location
    if (working.length) {
      location = working[working.length - 1];
      title = working.slice(0, -1).join(" ");
    }

    return { price, title, location, badge };
  }

  function getLocationFromAriaLabel(ariaLabel) {
    const withoutId = ariaLabel.replace(/,\s*listing\s+\d+$/, '');
    if (!withoutId) return '';
    const parts = withoutId.split(/,\s*/);
    const priceIdx = parts.findIndex(isPrice);
    if (priceIdx !== -1 && priceIdx < parts.length - 1) {
      return parts.slice(priceIdx + 1).join(', ');
    }
    return parts[parts.length - 1] || '';
  }

  function getTitleFromAriaLabel(ariaLabel) {
    const withoutId = ariaLabel.replace(/,\s*listing\s+\d+$/, '');
    if (!withoutId) return '';
    const parts = withoutId.split(/,\s*/);
    const priceIdx = parts.findIndex(isPrice);
    if (priceIdx > 0) return parts.slice(0, priceIdx).join(', ');
    return '';
  }

  function getListings() {
    const items = [
      ...document.querySelectorAll("a[href*='/marketplace/item/']")
    ];

    return items.map(a => {
      const lines = a.innerText
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

      const imgNode = a.querySelector("img");
      const image = imgNode ? imgNode.src : null;

      const ariaLabel = a.getAttribute('aria-label') || '';
      const { price, title: parsedTitle, location: parsedLocation, badge } = parseLines(lines);

      const location = getLocationFromAriaLabel(ariaLabel) || parsedLocation;
      const title = parsedTitle || getTitleFromAriaLabel(ariaLabel);

      // Remember what the grid told us about this item. When the user opens it,
      // the item page's own DOM is far harder to read than the card was.
      const key = itemKeyFromUrl(a.href);
      if (key && (location || price)) {
        if (itemFactsCache.size >= ITEM_FACTS_LIMIT && !itemFactsCache.has(key)) {
          itemFactsCache.delete(itemFactsCache.keys().next().value); // oldest out
        }
        itemFactsCache.set(key, { location, price, title, image });
      }

      return {
        title,
        location,
        price,
        badge,
        url: a.href,
        image
      };
    });
  }

  // -----------------------------
  // Item view scraping
  //
  // The old approach indexed blindly into the DOM (img[1], spans[2], spans[9]),
  // which breaks silently whenever Facebook reshuffles its markup. Each field
  // now tries meaning-based strategies first and only falls back to the old
  // positional lookup, so a layout change degrades instead of going blank.
  // -----------------------------

  // Elements holding their own text, in document order
  function leafTextNodes(root = document.body) {
    const out = [];
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (!el.childElementCount) {
          const t = (el.textContent || "").trim();
          if (t && t.length <= 120) return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function metaContent(prop) {
    const el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
    return el?.getAttribute("content")?.trim() || null;
  }

  function getItemTitle() {
    const h1 = document.querySelector("h1")?.textContent?.trim();
    if (h1) return h1;

    // Marketplace item pages are server-rendered with OG tags
    const og = metaContent("og:title");
    if (og) return og.replace(/\s*[|·-]\s*Facebook.*$/i, "").trim();

    return null;
  }

  // Returns { price, index } — index is where in `leaves` it was found, which
  // tells getItemLocation where to start looking.
  function getItemPrice(leaves) {
    // Strategy 1: the first price-looking leaf at or after the title
    const h1 = document.querySelector("h1");
    if (h1) {
      const start = leaves.findIndex(el => h1.contains(el) || el === h1);
      const from = start === -1 ? 0 : start;
      for (let i = from; i < Math.min(leaves.length, from + 60); i++) {
        const t = (leaves[i].textContent || "").trim();
        if (t.length <= 40 && isPrice(t)) return { price: t, index: i };
      }
    }

    // Strategy 2: anywhere on the page, shortest price-looking string wins
    let best = null;
    leaves.forEach((el, i) => {
      const t = (el.textContent || "").trim();
      if (t.length <= 40 && isPrice(t) && (!best || t.length < best.price.length)) {
        best = { price: t, index: i };
      }
    });
    if (best) return best;

    // Strategy 3 (legacy): positional lookup
    const spans = Array.from(document.querySelectorAll('div[aria-hidden=false]'));
    return { price: spans[2] ? spans[2].textContent : null, index: -1 };
  }

  // Rank a candidate photo by how much room it takes up on screen, or reject it.
  // Intrinsic size is the wrong measure: sidebar ad creatives are often larger
  // files than the listing photo while being rendered as small thumbnails.
  function scoreItemImage(img) {
    const src = img.currentSrc || img.src || "";
    if (!/fbcdn|scontent/.test(src)) return null;

    // Ads link off Facebook; the listing photo does not
    const link = img.closest("a");
    const href = link?.getAttribute("href") || "";
    if (/^https?:\/\//.test(href) && !/(^|\.)facebook\.com/.test(new URL(href, location.href).hostname)) {
      return null;
    }

    const rect = img.getBoundingClientRect();
    // Too small to be the main photo — avatars, ad thumbnails, icons
    if (rect.width < 140 || rect.height < 140) return null;
    if (rect.width * rect.height < 40000) return null;

    return { src, area: rect.width * rect.height };
  }

  function largestItemImage(nodes) {
    return [...nodes]
      .map(scoreItemImage)
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0]?.src || null;
  }

  function getItemImage() {
    // Strategy 1: the photo from the card we already scraped in the grid.
    // Exact by construction, and immune to whatever the item page looks like.
    const cached = itemFactsCache.get(itemKeyFromUrl(location.href));
    if (cached?.image) return cached.image;

    // Strategy 2: Facebook's own marker for primary media
    const marked = largestItemImage(document.querySelectorAll('img[data-visualcompletion="media-vc-image"]'));
    if (marked) return marked;

    // Strategy 3: the biggest thing actually rendered on the page
    const biggest = largestItemImage(document.querySelectorAll("img"));
    if (biggest) return biggest;

    // Strategy 4: og:image. Deliberately low priority — Marketplace is a single
    // page app, so after in-app navigation these tags still describe whichever
    // page was loaded first, which is how sidebar ads ended up on the map.
    const og = metaContent("og:image");
    if (og) return og;

    // Legacy positional fallback
    return Array.from(document.querySelectorAll('img'))[1]?.src || null;
  }

  function getItemLocation(leaves, { title, priceIndex }) {
    // Strategy 1: reuse what the results grid already told us about this item.
    // Language-independent and immune to item-page layout changes.
    const cached = itemFactsCache.get(itemKeyFromUrl(location.href));
    if (cached?.location) return cached.location;

    // Strategy 2: an explicitly labelled location region
    const labelled = document.querySelector(
      'div[aria-label*="ocation" i], a[href*="/marketplace/"][aria-label*="ocation" i]'
    );
    const labelledText = labelled?.textContent?.trim();
    if (labelledText && labelledText.length <= 60) return labelledText;

    // Strategy 3: a "City, Region" shaped leaf. Only look after the price —
    // before it sits the title, which has exactly the same shape.
    const shaped = /^[\p{Lu}\p{Lo}][\p{L}.'’\-]*(?:[ \-][\p{L}.'’\-]+){0,3}(?:,\s*[\p{L}][\p{L}.'’ \-]{1,30})?$/u;
    const h1 = document.querySelector("h1");
    const from = priceIndex >= 0 ? priceIndex + 1 : 0;

    for (let i = from; i < leaves.length; i++) {
      const el = leaves[i];
      const t = (el.textContent || "").trim();

      if (t.length < 2 || t.length > 45) continue;
      if (/\d/.test(t) || isPrice(t)) continue;
      if (title && t === title.trim()) continue;      // never the title
      if (h1 && (h1.contains(el) || el === h1)) continue;
      if (!shaped.test(t)) continue;
      // Skip obvious UI chrome
      if (/^(save|share|send|message|seller|details|marketplace|buy|sell)$/i.test(t)) continue;

      return t;
    }

    // Strategy 4 (legacy): positional lookup
    const spans = Array.from(document.querySelectorAll('div[aria-hidden=false]'));
    return spans[9] ? spans[9].querySelector('span')?.textContent : null;
  }

  function scrapeItemView() {
    const leaves = leafTextNodes();
    const title = getItemTitle();
    const { price, index: priceIndex } = getItemPrice(leaves);

    return {
      title,
      price,
      image: getItemImage(),
      location: getItemLocation(leaves, { title, priceIndex })
    };
  }

  // -----------------------------
  // Get user current Marketplace location
  // -----------------------------
  function getMarketplaceLocation() {
    let context = { lat: null, lon: null, country: null, admin1: null };

    // Preferred source: the MAIN-world bridge. Reading the page state directly
    // from here never works (isolated world), so the block below is only a
    // fallback for the case where the bridge script didn't run.
    if (pageContext) return { ...pageContext };

    try {
      const state = window.__PRELOADED_STATE__ || {};

      // Try multiple known paths — Facebook changes these periodically
      const candidates = [
        state.marketplace?.user_current_location,
        state.marketplace?.saved_searches_location,
        state.marketplace?.marketplaceUserCurrentLocation,
        state.marketplaceUserCurrentLocation,
        state.marketplace?.location,
        state.currentLocation,
      ];

      const loc = candidates.find(l => l && (l.latitude || l.lat));

      if (loc) {
        const lat = loc.latitude ?? loc.lat ?? null;
        const lon = loc.longitude ?? loc.lon ?? loc.lng ?? null;

        // Only accept real coordinates — a bad pair would drag the map's
        // initial view somewhere nonsensical
        const usable = typeof lat === "number" && typeof lon === "number"
          && Number.isFinite(lat) && Number.isFinite(lon)
          && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

        if (usable) {
          context.lat = lat;
          context.lon = lon;

          const rg = loc.reverse_geocode || loc.reverseGeocode || loc.geocode;
          if (rg) {
            context.country = rg.country || rg.countryCode || null;
            context.admin1 = rg.state || rg.province || rg.region || null;
          }
        }
      }
    } catch (e) { console.warn("Marketplace location detection failed", e); }

    return context;
  }


  itemScraped = false
  // Send listings to iframe every 2s.
  // injectMap() runs again on every route change, so drop the previous timer
  // instead of stacking a new scraper on top of it.
  if (window.__mkpScrapeTimer) clearInterval(window.__mkpScrapeTimer);
  const scrapeTick = () => {

    // scrape all listings
    let listings = getListings();

    // scrape listing if standing on item view
    if (location.href.includes('/item/')) {
      const { title, price, image, location: itemLocation } = scrapeItemView()

      if (image && price && itemLocation && title) {
        itemScraped = true
        listings = listings.concat({
          title,
          location: itemLocation,
          price,
          badge: '',
          url: location.href,
          image
        })
      }
    }

    reportScrapeHealth(listings);

    const iframe = document.getElementById("mkp-mapper-frame");
    if (iframe && iframe.contentWindow) {
      // console.log('sending listsings', listings)
      iframe.contentWindow.postMessage({
        source: "marketplace-mapper",
        listings,
        url: lastUrl,
        context: getMarketplaceLocation(),
        city: lastCity, // currently not used
        itemScraped
      }, "*");
    }
  };

  // Run once now as well as on the interval: setInterval doesn't fire at t=0,
  // so the first batch of listings used to be two seconds away for no reason.
  scrapeTick();
  window.__mkpScrapeTimer = setInterval(scrapeTick, 2000);
}

// Run at first load
if (location.pathname.startsWith("/marketplace")) {
  injectMap();
}