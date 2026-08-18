// Packaging: every file a manifest promises must actually be in the build, and
// the two builds must not drift apart.
//
// This exists because edge-extension/ shipped for a while with no data/
// directory at all — its manifest declared the city database, the file wasn't
// there, and geocoding simply could not work. Nothing else would catch that.
import fs from "fs";
import path from "path";
import { ROOT, makeChecker } from "./lib.mjs";

const { check, state } = makeChecker();
const BUILDS = ["extension", "edge-extension"];

// Files that are genuinely per-build may be listed here; today there are none.
const SHARED = ["content.js", "map.js", "map.html", "header.js", "page-context.js",
                "manifest.json", "data/cities_db.json.gz"];

for (const build of BUILDS) {
  console.log(`\n=== ${build} ===`);
  const dir = path.join(ROOT, build);
  const manifestPath = path.join(dir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    check(`${build}: manifest exists`, false);
    continue;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  check(`${build}: manifest parses`, !!manifest.version, manifest.version);

  const missing = [];
  const want = (rel) => {
    // web_accessible_resources may use globs
    if (rel.includes("*")) {
      const base = path.join(dir, path.dirname(rel));
      if (!fs.existsSync(base) || !fs.readdirSync(base).length) missing.push(rel);
      return;
    }
    if (!fs.existsSync(path.join(dir, rel))) missing.push(rel);
  };

  for (const cs of manifest.content_scripts || []) (cs.js || []).forEach(want);
  for (const war of manifest.web_accessible_resources || []) (war.resources || []).forEach(want);
  Object.values(manifest.icons || {}).forEach(want);
  Object.values(manifest.action?.default_icon || {}).forEach(want);

  check(`${build}: every declared file is present`, missing.length === 0, missing.join(", "));

  const db = path.join(dir, "data/cities_db.json.gz");
  if (fs.existsSync(db)) {
    const mb = fs.statSync(db).size / 1e6;
    check(`${build}: city database looks complete`, mb > 5, `${mb.toFixed(1)} MB`);
  }
}

console.log("\n=== Builds stay in sync ===");
{
  const [a, b] = BUILDS.map(x => path.join(ROOT, x));
  for (const rel of SHARED) {
    const pa = path.join(a, rel), pb = path.join(b, rel);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) {
      check(`${rel}: present in both builds`, false);
      continue;
    }
    check(`${rel}: identical in both builds`,
      fs.readFileSync(pa).equals(fs.readFileSync(pb)));
  }

  const versions = BUILDS.map(x =>
    JSON.parse(fs.readFileSync(path.join(ROOT, x, "manifest.json"), "utf8")).version);
  check("manifest versions match", versions[0] === versions[1], versions.join(" vs "));
}

console.log(state.fail ? `\n${state.fail} FAILURE(S)` : `\nAll ${state.pass} checks passed`);
process.exit(state.fail ? 1 : 0);
