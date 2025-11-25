(function () {
  // Inject iframe only once
  if (!document.getElementById("market-map-frame")) {
    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("map.html");
    iframe.id = "market-map-frame";

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

  function getCurrentSelectedLocation() {
    // Find the button that contains the location
    const buttonDivs = Array.from(document.querySelectorAll('div[role="button"]'));

    for (const div of buttonDivs) {
      const span = div.querySelector('span');
      if (!span) continue;

      // Only take text nodes directly under the span
      const city = Array.from(span.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join("");

      // Quick sanity check: skip if empty or looks like distance
      if (city && !/\d+\s?km/i.test(city)) return city;
    }

    return null;
  }

  // Send listings to iframe every 2s
  setInterval(() => {
    const listings = getListings();
    const iframe = document.getElementById("market-map-frame");
    if (iframe && iframe.contentWindow) {
      // console.log('sending listsings', listings)
      iframe.contentWindow.postMessage({
        source: "marketplace-mapper",
        listings
      }, "*");
    }

    // Send a message from content.js when page loads
    const cityName = getCurrentSelectedLocation();
    if (cityName) {
      window.postMessage({
        source: 'marketplace-mapper-content',
        type: 'INITIAL_CITY',
        city: cityName
      }, '*');
    }
  }, 2000);
})();
