let map = L.map('map').setView([57.7, 11.97], 11); // Gothenburg default

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18
}).addTo(map);

let markers = [];


async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json[0]) return null;
  return { lat: json[0].lat, lon: json[0].lon };
}


window.addEventListener("message", async (event) => {
  if (event.data.type !== "LISTINGS") return;

  const listings = event.data.listings;

  // Clear old markers
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  for (const item of listings) {
    const coords = await geocode(item.location);
    if (!coords) continue;

    const marker = L.marker([coords.lat, coords.lon]).addTo(map);
    markers.push(marker);

    marker.bindPopup(`
      <b>${item.title}</b><br>
      <a href="${item.url}" target="_blank">Open listing</a>
    `);
  }
});


