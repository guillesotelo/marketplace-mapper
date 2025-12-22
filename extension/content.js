let lastUrl = location.href;
let mapClosed = false;
let lastCity = null;
let scheduled = false;


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
      height: "520px",
      zIndex: 999999,
      border: "1px solid #354c80",
      background: "#354c80",
      borderRadius: "8px"
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
          iframe.style.left = eMove.clientX - offsetX + "px";
          iframe.style.top = eMove.clientY - offsetY + "px";
        };

        onMouseUp = () => {
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
        }
      }
      else if (event.data.type === "close-map") {
        mapClosed = true
        iframe.remove()
      }
    });

    document.body.appendChild(iframe);
  }

  function isMileage(text) {
    if (!text) return false;

    const t = text.toLowerCase().replace(/\s+/g, " ").trim();

    // Matches:
    //  "130 miles", "220,000 km", "145k miles", "87.000 km", "108 mil millas"
    return (
      /\b\d[\d.,]*\s?(km|kms|kilometers|kilometros|miles|mi|millas)\b/.test(t) ||
      /\b\d[\d.,]*k\b/.test(t) ||
      /\b\d+\s?(mil)\s?(millas|km)\b/.test(t)
    );
  }

  // Scrape Marketplace listings
  function getListings() {
    const items = [...document.querySelectorAll("a[href*='/marketplace/item/']")];

    return items.map(a => {
      const fullText = a.innerText.trim();
      const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);

      let price = "";
      let title = "";
      let location = "";

      if (lines.length === 1) {
        title = lines[0];
      } else if (lines.length >= 2) {
        price = lines[0];
        title = lines[1];

        // Look for the first line AFTER title that is NOT mileage
        for (let i = 2; i < lines.length; i++) {
          if (!isMileage(lines[i])) {
            location = lines[i];
            break;
          }
        }
      }

      // Extract image if available
      const imgNode = a.querySelector("img");
      const image = imgNode ? imgNode.src : null;

      return {
        title,
        location,
        price,
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
    const listings = getListings();
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