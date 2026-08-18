# Marketplace Map (Chrome Extension)

Floating map of Facebook Marketplace listings.

## Description

Marketplace Map enhances your Facebook Marketplace browsing experience by displaying visible listings on a live, draggable map overlay.
It helps you:

- Understand where listings are located geographically

- Compare items by distance

- Explore nearby offers visually

- Quickly navigate between neighborhoods or cities

Perfect for buyers who prefer a spatial overview of what’s available.

## Features

**🗺️ Floating Map Overlay**
A movable, resizable iframe map displayed directly on Facebook Marketplace pages.

**📍 Geolocation of Listings**
Automatically extracts location text from listings (e.g., city/neighborhood) and plots them on the map.

**🏷️ Inline Item Details**
See prices, titles, distances, and thumbnails directly on the map pins.

**✏️ Draw-an-Area Filter**
Lasso a neighborhood directly on the map and everything outside it drops away — not a radius, the actual shape you'd travel to.

**✨ New Since Your Last Visit**
The map remembers which listings it has already shown you and flags the rest, so a return visit starts with what changed.

**⬇️ Auto-Load Listings**
Optionally sweeps the page to pull more listings onto the map, then returns you to where you were. Scroll at any time to stop it.

**🖱️ Drag & Position Anywhere**
Move the map window freely without interfering with Facebook’s interface.

**⚡ Lightweight & Non-intrusive**
No account, no backend, no data collection. All processing happens locally in the browser.

## Tests

Regression suites that drive the real extension files in a real Chromium — no
mocks of our own code, because most bugs here come from browser behaviour
(isolated worlds, Leaflet transforms, SPA-stale meta tags) that a fake DOM would
happily report as working.

```bash
cd tests
npm install          # playwright-core
npm test             # all suites
node geo.test.mjs    # or just one
```

Needs a Chromium: one from a `playwright install`, or `CHROME_PATH=/path/to/chrome`.

| suite | covers |
| --- | --- |
| `geo.test.mjs` | which country a search resolves to, across 6 regions, plus the manual region override |
| `scrape.test.mjs` | grid + item scraping, a simulated Facebook redesign, silent-failure detection |
| `image.test.mjs` | picking the listing photo rather than a sidebar ad |
| `map.test.mjs` | new-since-last-visit, the area lasso, the health banner, tooltip fit |
| `autoload.test.mjs` | the sweep stops on demand, on user scroll, and always by itself |

## Store assets

`store-assets/` holds the promo tiles and the animated demo. To re-render the demo
after a UI change:

```bash
node store-assets/build-demo.js     # composes demo-src.html from promo-src.html
node store-assets/capture-demo.mjs  # writes demo.gif + demo.mp4 (needs ffmpeg)
```

## Local Installation

1. Clone this repository to your local machine:

```bash
git clone https://github.com/guillesotelo/marketplace-map.git
```

2. Go to [Google Extensions](chrome://extensions/), enable _Developer Mode_ and upload the package by clicking **Load unpacked**.
3. Go to Confluence Pages and test it out!

## Disclaimer

This extension is a _work in progress_.
Feedback is welcome and helps improve the tool for everyone.

If you find issues or have suggestions:

- Open an issue in the repository, or

- Contact me at guille.sotelo.cloud@gmail.com

Thanks for contributing and testing! 💛
