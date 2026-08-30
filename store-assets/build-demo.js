// Builds demo-src.html from promo-src.html so the two stay visually in sync.
// promo-src.html owns the brand styling and the mock map panel; this adds an
// animation timeline on top for the demo GIF / video.
//
//   node store-assets/build-demo.js
//
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const promo = fs.readFileSync(path.join(dir, "promo-src.html"), "utf8");

const SPLIT = '<script src="../extension/leaflet/leaflet.js"></script>';
const head = promo.slice(0, promo.indexOf(SPLIT));

const extraStyle = `
    <style>
        /* ---------- Demo-only animation styles ---------- */
        #headline, #sub, #feature-slot { transition: opacity .45s ease; }
        .fading { opacity: 0 !important; }

        /* Never animate transform on .mkp-pin-wrap — Leaflet positions markers
           with a transform on that element, so animating it moves every pin to
           the pane origin. Animate the inner .mkp-pin instead. Opacity has to
           beat the inline style Leaflet's setOpacity() writes. */
        .mkp-pin-wrap { transition: opacity .45s ease; }
        .pin-hidden { opacity: .12 !important; }
        .pin-drop .mkp-pin { animation: pin-drop .5s cubic-bezier(.2, 1.3, .5, 1) both; }

        @keyframes pin-drop {
            from { transform: translateY(-22px) scale(.4); opacity: 0; }
            to   { transform: translateY(0) scale(1); opacity: 1; }
        }

        .mkp-pin-new { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #e5484d; }

        .mkp-tool-btn.has-new::before {
            content: attr(data-count);
            position: absolute;
            top: -1px; right: -1px;
            min-width: 14px; height: 14px;
            padding: 0 3px;
            box-sizing: border-box;
            background: #e5484d; color: #fff;
            font-size: .55rem; font-weight: bold; line-height: 14px;
            text-align: center; border-radius: 999px;
        }

        .mkp-tool-btn { position: relative; }

        #mkp-area-hint {
            position: absolute;
            bottom: 14px; left: 50%;
            transform: translateX(-50%);
            background: rgba(53, 76, 128, .94);
            color: #fff;
            font-size: 13px;
            padding: 6px 14px;
            border-radius: 999px;
            white-space: nowrap;
            z-index: 1100;
            opacity: 0;
            transition: opacity .35s ease;
        }

        #mkp-area-hint.show { opacity: 1; }

        .mkp-new-chip {
            display: inline-block;
            align-self: flex-start;
            background: #e5484d; color: #fff;
            font-size: 11px; font-weight: bold;
            padding: 1px 6px; border-radius: 4px;
            margin-bottom: 4px;
        }

        /* The panel has no z-index of its own, so Leaflet's panes and controls
           (z-index 400-800) escape into the root stacking context and paint over
           anything layered on top of the stage. Give the panel its own context
           so those stay contained, and put the end card above it. */
        #window { z-index: 1; }

        #endcard {
            position: absolute;
            inset: 0;
            z-index: 50;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 18px;
            text-align: center;
            padding: 0 80px;
            background:
                radial-gradient(900px 600px at 88% -10%, #55719f 0%, rgba(85, 113, 159, 0) 60%),
                radial-gradient(800px 700px at -5% 105%, #22335c 0%, rgba(34, 51, 92, 0) 55%),
                linear-gradient(135deg, #2c4070 0%, #354c80 55%, #3f5a96 100%);
            color: #fff;
            opacity: 0;
            transition: opacity .5s ease;
            pointer-events: none;
        }

        #endcard.show { opacity: 1; }
        #endcard h2 { font-size: 54px; margin: 0; font-weight: 800; letter-spacing: -.5px; }
        #endcard h2 em { color: #ffc472; font-style: normal; }
        #endcard p { font-size: 22px; margin: 0; opacity: .9; }

        #endcard .pill {
            margin-top: 10px;
            font-size: 17px;
            background: #ffc472; color: #2c4070;
            font-weight: 700;
            padding: 12px 26px;
            border-radius: 999px;
        }
    </style>
`;

const demoScript = `
    <script>
        // ---------------------------------------------------------------
        // Demo timeline. Everything is time-driven so a frame grabber can
        // just screenshot on a fixed interval.
        // ---------------------------------------------------------------
        const MARKER_COLORS = {
            default: "#3b6fd4", bookmark: "#f4b400",
            free: "#0f9d58", fresh: "#ff6d00"
        };

        const bikeImg = "data:image/svg+xml;utf8," + encodeURIComponent(\`
        <svg xmlns="http://www.w3.org/2000/svg" width="400" height="230" viewBox="0 0 400 230">
            <rect width="400" height="230" fill="#dfe7e2"/>
            <rect x="0" y="170" width="400" height="60" fill="#b9c6bd"/>
            <g stroke="#33414f" stroke-width="7" fill="none" stroke-linecap="round">
              <circle cx="120" cy="150" r="44"/><circle cx="290" cy="150" r="44"/>
              <path d="M120 150 L185 78 L268 78 L290 150 L200 150 L165 96"/>
              <path d="M120 150 L165 96"/>
              <path d="M185 78 L172 62 M160 62 h24"/>
              <path d="M268 78 L262 58 M248 58 h28"/>
            </g>
            <circle cx="200" cy="150" r="10" fill="#e0632f"/>
        </svg>\`);

        const lampImg = "data:image/svg+xml;utf8," + encodeURIComponent(\`
        <svg xmlns="http://www.w3.org/2000/svg" width="400" height="230" viewBox="0 0 400 230">
            <rect width="400" height="230" fill="#eae6de"/>
            <rect x="0" y="176" width="400" height="54" fill="#cfc7b8"/>
            <path d="M150 40 h100 l26 62 h-152z" fill="#e0b36a"/>
            <rect x="194" y="102" width="12" height="70" fill="#5d5145"/>
            <ellipse cx="200" cy="178" rx="52" ry="10" fill="#5d5145"/>
            <circle cx="200" cy="112" r="16" fill="#fff3d6"/>
        </svg>\`);

        function makePinIcon(color, starred, isNew) {
            return L.divIcon({
                className: "mkp-pin-wrap",
                html: '<div class="mkp-pin' + (isNew ? ' mkp-pin-new' : '') + '" style="background:' +
                      color + '">' + (starred ? "★" : "") + '</div>',
                iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10]
            });
        }

        function popupHtml(l) {
            return \`
            <div style="position: relative;">
                \${l.badge ? '<p style="margin:0;font-size:.75rem;font-style:italic;position:absolute;top:0;left:0;z-index:5;padding:.2rem .4rem;background:#fff;border-top-left-radius:.5rem;border-bottom-right-radius:.5rem;">' + l.badge + '</p>' : ""}
                <img src="\${l.image}" style="width:100%;height:auto;display:block;border-radius:.3rem .3rem 0 0;">
            </div>
            <div style="display:flex;flex-direction:column;margin:.4rem .5rem .5rem;">
                \${l.isNew ? '<span class="mkp-new-chip">NEW since your last visit</span>' : ""}
                <p style="margin:0;font-size:.9rem;font-weight:bold;">\${l.price}</p>
                <p style="margin:0;">\${l.title}</p>
                <p style="margin:0 0 .3rem 0;font-size:.8rem;color:#858585;">\${l.location}</p>
                <div style="display:flex;align-items:center;gap:.6rem;">
                    <a href="#">Open Listing</a>
                    <button type="button" style="background:none;border:none;font-size:.9rem;color:#b8860b;padding:0;">☆ Save</button>
                </div>
            </div>\`;
        }

        const CENTER = [52.3676, 4.9041];
        const map = L.map("mkp-mapper-map", {
            zoomControl: true, fadeAnimation: false,
            zoomAnimation: false, markerZoomAnimation: false
        }).setView(CENTER, 13);

        // Keyed so re-renders don't bake in the "API KEY REQUIRED" watermark.
        window.CARTO_KEY = window.CARTO_KEY || window.MKPM_BASEMAP_KEY || "";
        L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" +
            (window.CARTO_KEY ? "?key=" + window.CARTO_KEY : ""), {
            attribution: '&copy; OpenStreetMap &copy; CARTO'
        }).addTo(map);

        // Inject the two newer tools so the demo matches the shipping UI
        const tools = document.getElementById("mkp-mapper-tools");
        const sep = tools.querySelector(".mkp-tool-sep");
        const newBtn = document.createElement("button");
        newBtn.className = "mkp-tool-btn";
        newBtn.id = "mkp-tool-new";
        newBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 3l1.5 4.3L16 9l-4.5 1.7L10 15l-1.5-4.3L4 9l4.5-1.7z"/><path d="M17.5 13l.8 2.4 2.2.9-2.2.9-.8 2.3-.8-2.3-2.2-.9 2.2-.9z"/></svg>';
        const areaBtn = document.createElement("button");
        areaBtn.className = "mkp-tool-btn";
        areaBtn.id = "mkp-tool-area";
        areaBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17.66 3.34a2 2 0 0 0-2.83 0l-1.1 1.1-1.44-1.44a1 1 0 0 0-1.41 1.41l1.43 1.44-6.4 6.4a3 3 0 0 0-.83 1.62l-.6 3.3a1 1 0 0 0 1.17 1.16l3.3-.6a3 3 0 0 0 1.61-.83l6.4-6.4 1.44 1.44a1 1 0 0 0 1.41-1.42l-1.43-1.43 1.1-1.1a2 2 0 0 0 0-2.83zM4 20a1 1 0 0 0 0 2h16a1 1 0 0 0 0-2z"/></svg>';
        tools.insertBefore(areaBtn, sep);
        tools.insertBefore(newBtn, areaBtn);

        const hint = document.createElement("div");
        hint.id = "mkp-area-hint";
        document.getElementById("mkp-mapper-map").appendChild(hint);

        const endcard = document.createElement("div");
        endcard.id = "endcard";
        endcard.innerHTML =
            '<img src="../extension/assets/icons/mkpm128.png" alt="" ' +
            'style="width:88px;height:88px;padding:9px;background:#fff;border-radius:20px;' +
            'box-shadow:0 10px 30px rgba(0,0,0,.35);margin-bottom:6px;">' +
            '<h2>Every listing, on <em>one map</em></h2>' +
            '<p>A live map overlay for Facebook Marketplace</p>' +
            '<div class="pill">Free · No account · Nothing leaves your browser</div>';
        document.getElementById("stage").appendChild(endcard);

        // listings: [lat, lon, kind]
        const spots = [
            [52.3702, 4.8850, "default"], [52.3579, 4.8686, "default"],
            [52.3789, 4.9000, "default"], [52.3538, 4.9110, "default"],
            [52.3745, 4.9245, "fresh"],   [52.3620, 4.9330, "default"],
            [52.3838, 4.8770, "free"],    [52.3499, 4.8930, "default"],
            [52.3775, 4.9128, "bookmark"],[52.3596, 4.9000, "fresh"],
            [52.3660, 4.8600, "default"], [52.3862, 4.9060, "default"],
            [52.3562, 4.9125, "default"], [52.3640, 4.8960, "default"],
            [52.3712, 4.9150, "default"]
        ];

        const markers = spots.map(([lat, lon, kind]) => {
            const color = MARKER_COLORS[kind] || MARKER_COLORS.default;
            const m = L.marker([lat, lon], {
                icon: makePinIcon(color, kind === "bookmark"), opacity: 0
            }).addTo(map);
            m.kind = kind;
            m.latlon = [lat, lon];
            return m;
        });

        const headline = document.getElementById("headline");
        const sub = document.getElementById("sub");
        const slot = document.getElementById("feature-slot");
        document.getElementById("store-note").style.opacity = ".75";

        const wait = ms => new Promise(r => setTimeout(r, ms));

        async function caption(title, text, bullets) {
            [headline, sub, slot].forEach(e => e.classList.add("fading"));
            await wait(450);
            headline.innerHTML = title;
            sub.textContent = text;
            slot.innerHTML = bullets
                ? '<ul class="feats">' + bullets.map(b => '<li><span class="dot"><svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>' + b + '</li>').join("") + '</ul>'
                : "";
            [headline, sub, slot].forEach(e => e.classList.remove("fading"));
            await wait(450);
        }

        function pointInRing(ring, lat, lon) {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [yi, xi] = ring[i], [yj, xj] = ring[j];
                if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
        }

        async function run() {
            await caption('Every listing,<br>on <em>one map</em>',
                "Marketplace Map adds a live, draggable map to Facebook Marketplace.");

            // --- Pins appear as you browse
            for (const m of markers) {
                m.setOpacity(1);
                m._icon?.classList.add("pin-drop");
                await wait(110);
            }
            await wait(500);

            // --- Photo, price and location at a glance
            await caption('See the <em>details</em><br>without leaving the map',
                "Every pin carries the photo, the price and the neighborhood.",
                ["Photo, price & location", "Open the listing in one click"]);

            const focus = markers[12];
            focus.bindPopup(popupHtml({
                image: bikeImg, badge: "Just listed", price: "€120",
                title: "Vintage road bike — rides great", location: "Amsterdam Oost"
            }), { autoPan: false }).openPopup();
            await wait(2600);
            focus.closePopup();

            // --- Draw an area
            await caption('Draw the area<br>you <em>actually</em> travel to',
                "Lasso a neighborhood and everything outside it drops off the map.",
                ["Freehand area filter", "Not just a radius"]);

            areaBtn.classList.add("active");
            hint.textContent = "Draw an area on the map";
            hint.classList.add("show");
            await wait(700);

            // Trace a ring around the central cluster
            const boxLat = [52.3560, 52.3800], boxLon = [4.8880, 4.9230];
            const ring = [];
            const steps = 26;
            for (let i = 0; i < steps; i++) {
                const t = i / steps * 4;
                let lat, lon;
                if (t < 1)      { lat = boxLat[0] + (boxLat[1] - boxLat[0]) * t;       lon = boxLon[0]; }
                else if (t < 2) { lat = boxLat[1]; lon = boxLon[0] + (boxLon[1] - boxLon[0]) * (t - 1); }
                else if (t < 3) { lat = boxLat[1] - (boxLat[1] - boxLat[0]) * (t - 2); lon = boxLon[1]; }
                else            { lat = boxLat[0]; lon = boxLon[1] - (boxLon[1] - boxLon[0]) * (t - 3); }
                // wobble so it reads as hand-drawn
                ring.push([lat + (Math.sin(i * 2.1) * 0.0009), lon + (Math.cos(i * 1.7) * 0.0013)]);
            }

            const trace = L.polyline([], { color: "#354c80", weight: 3, dashArray: "5 5" }).addTo(map);
            for (const p of ring) { trace.addLatLng(p); await wait(55); }
            trace.addLatLng(ring[0]);
            await wait(150);
            map.removeLayer(trace);

            const poly = L.polygon(ring, {
                color: "#354c80", weight: 3, fillColor: "#354c80", fillOpacity: .10
            }).addTo(map);

            let kept = 0;
            for (const m of markers) {
                const inside = pointInRing(ring, m.latlon[0], m.latlon[1]);
                if (inside) kept++;
                else m._icon?.classList.add("pin-hidden");
            }
            areaBtn.classList.remove("active");
            hint.textContent = kept + " listings in your area";
            await wait(2300);

            // --- New since last visit
            map.removeLayer(poly);
            markers.forEach(m => m._icon?.classList.remove("pin-hidden"));
            hint.classList.remove("show");

            await caption('Come back to<br>see <em>what\\'s new</em>',
                "The map remembers what you have already seen and flags the rest.",
                ["New-since-last-visit filter", "Nothing leaves your browser"]);

            const freshOnes = [1, 5, 9, 11];
            freshOnes.forEach(i => {
                const m = markers[i];
                m.setIcon(makePinIcon(MARKER_COLORS[m.kind] || MARKER_COLORS.default, false, true));
            });
            newBtn.dataset.count = String(freshOnes.length);
            newBtn.classList.add("has-new");
            await wait(700);

            newBtn.classList.add("active");
            markers.forEach((m, i) => { if (!freshOnes.includes(i)) m._icon?.classList.add("pin-hidden"); });
            await wait(600);

            markers[9].bindPopup(popupHtml({
                image: lampImg, price: "€25", isNew: true,
                title: "Brass desk lamp", location: "Amsterdam Centrum"
            }), { autoPan: false }).openPopup();
            await wait(2400);

            // --- End card
            endcard.classList.add("show");
            await wait(2200);

            window.__demoDone = true;
        }

        // Give the tiles a moment to paint before the timeline starts
        window.addEventListener("load", () => setTimeout(run, 1200));
    </script>
`;

const out = head + SPLIT + demoScript + "\n</body>\n\n</html>\n";
const withStyle = out.replace("</head>", extraStyle + "</head>");

fs.writeFileSync(path.join(dir, "demo-src.html"), withStyle);
console.log("wrote store-assets/demo-src.html");
