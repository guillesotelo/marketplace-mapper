function injectMap() {
  const iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("map.html");
  iframe.id = "market-map";
  document.body.appendChild(iframe);
}
injectMap();


function getListings() {
  const items = [...document.querySelectorAll("a[href*='/marketplace/item/']")];

  return items.map(item => {
    const title = item.innerText.trim();
    const locationNode = item.querySelector("span");
    const location = locationNode ? locationNode.innerText : "Unknown";

    return {
      title,
      location,
      url: item.href
    };
  });
}

setInterval(() => {
  const listings = getListings();
  const iframe = document.getElementById("market-map");
  iframe.contentWindow.postMessage({ type: "LISTINGS", listings }, "*");
}, 2000);
