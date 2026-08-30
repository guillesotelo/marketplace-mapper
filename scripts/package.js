// Builds extension.zip and edge-extension.zip for store upload.
//
// Refuses to package without a basemap key, because a keyed build is
// indistinguishable from an unkeyed one until users see the watermark.
//
//   node scripts/package.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BUILDS = ["extension", "edge-extension"];

for (const build of BUILDS) {
  const dir = path.join(ROOT, build);
  const keyFile = path.join(dir, "basemap-key.js");

  if (!fs.existsSync(keyFile) || !/MKPM_BASEMAP_KEY = "\S/.test(fs.readFileSync(keyFile, "utf8"))) {
    console.error(`${build}: no basemap key. Run:  node scripts/set-basemap-key.js`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const zip = path.join(ROOT, `${build}.zip`);
  fs.rmSync(zip, { force: true });

  // -x excludes junk that would otherwise ship
  execFileSync("zip", ["-r", "-q", zip, ".",
    "-x", ".DS_Store", "-x", "**/.DS_Store", "-x", "utils/*"], { cwd: dir });

  const mb = fs.statSync(zip).size / 1e6;
  console.log(`${build}.zip  v${manifest.version}  ${mb.toFixed(1)} MB`);
}
