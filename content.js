let lastUrl = location.href;

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    onRouteChange();
  }
});

observer.observe(document, { subtree: true, childList: true });

function onRouteChange() {
  if (location.pathname.startsWith("/marketplace")) {
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
      border: "1px solid #ccc",
      background: "#fff",
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

        iframe.style.zIndex = 10000000;

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
        iframe.remove()
      }
    });

    document.body.appendChild(iframe);
  }

  // Scrape Marketplace listings
  function getListings() {
    const items = [...document.querySelectorAll("a[href*='/marketplace/item/']")];

    return items.map(a => {
      const fullText = a.innerText.trim();
      const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);

      let price = "";
      let location = "";
      let title = "";

      if (lines.length === 1) {
        title = lines[0];
      } else if (lines.length === 2) {
        price = lines[0];
        title = lines[1];
      } else {
        price = lines[0];
        title = lines[1];
        location = lines[lines.length - 1];
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

  // Send listings to iframe every 2s
  setInterval(() => {
    const listings = getListings();
    const iframe = document.getElementById("mkp-mapper-frame");
    if (iframe && iframe.contentWindow) {
      // console.log('sending listsings', listings)
      iframe.contentWindow.postMessage({
        source: "marketplace-mapper",
        listings
      }, "*");
    }
  }, 2000);
}

// Run at first load
if (location.pathname.startsWith("/marketplace")) {
  injectMap();
}