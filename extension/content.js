let lastUrl = location.href;
let mapClosed = false;
let lastCity = null;
let scheduled = false;
const iframeHeight = '520px'

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
  if (location.pathname.startsWith("/marketplace") && !mapClosed) {
    injectMap();
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
    });

    document.body.appendChild(iframe);
    setTimeout(() => {
      iframe.style.opacity = 1
    }, 4000)
  }

  function isPrice(text) {
    return /\d/.test(text) &&
      /(\p{Sc}|\b[A-Z]{2,3}\b|kr|€|£|usd|eur|sek|nok|dkk)/iu.test(text);
  }

  // Loosen function just for badge detection
  function looksLikePrice(text) {
    return /\d/.test(text);
  }

  function parseLines(lines) {
    const priceIndex = lines.findIndex(isPrice);
    if (priceIndex === -1) return {};

    const price = lines[priceIndex];
    const location = lines[lines.length - 1] || "";
    const hasBadge =
      lines.length >= 2 &&
      !looksLikePrice(lines[0]) &&
      looksLikePrice(lines[1]);

    let title = "";
    if (priceIndex + 1 < lines.length - 1) {
      title = lines[priceIndex + 1];
    }

    const badge = hasBadge ? lines[0] : "";

    return { price, title, location, badge };
  }

  // Scrape Marketplace listings
  function getListings() {
    const items = [...document.querySelectorAll("a[href*='/marketplace/item/']")];

    return items.map(a => {
      const lines = a.innerText
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

      const imgNode = a.querySelector("img");
      const image = imgNode ? imgNode.src : null;

      const { price, title, location, badge } = parseLines(lines);

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
  // Get user current Marketplace location
  // -----------------------------
  function getMarketplaceLocation() {
    let context = { lat: null, lon: null, country: null, admin1: null };

    try {
      // 1. Try __PRELOADED_STATE__ (SPA)
      const state = window.__PRELOADED_STATE__ || {};
      const loc = state.marketplace?.user_current_location || state.marketplace?.saved_searches_location;
      if (loc && loc.latitude && loc.longitude) {
        context.lat = loc.latitude;
        context.lon = loc.longitude;

        // Try reverse geocode for country/admin1
        if (loc.reverse_geocode) {
          context.country = loc.reverse_geocode.country || null;
          context.admin1 = loc.reverse_geocode.state || null; // or "province"
        }
      }
    } catch (e) { console.warn("Marketplace location detection failed", e); }

    return context;
  }


  // Send listings to iframe every 2s
  setInterval(() => {

    // scrape all listings
    let listings = getListings();

    // scrape listing if standing on item view
    if (location.href.includes('/item/')) {
      const image = Array.from(document.querySelectorAll('img'))[1]?.src
      const spans = Array.from(document.querySelectorAll('div[aria-hidden=false]'))
      const price = spans[2] ? spans[2].textContent : null
      const itemLocation = spans[9] ? spans[9].querySelector('span')?.textContent : null
      const title = document.querySelector('h1')?.textContent

      if (image && price && itemLocation && title) {
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

    const iframe = document.getElementById("mkp-mapper-frame");
    if (iframe && iframe.contentWindow) {
      // console.log('sending listsings', listings)
      iframe.contentWindow.postMessage({
        source: "marketplace-mapper",
        listings,
        url: location.href,
        context: getMarketplaceLocation(),
        city: lastCity // currently not used
      }, "*");
    }
  }, 2000);
}

// Run at first load
if (location.pathname.startsWith("/marketplace")) {
  injectMap();
}