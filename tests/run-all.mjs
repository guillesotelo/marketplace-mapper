// Runs every suite and prints one summary.  node tests/run-all.mjs
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = fs.readdirSync(dir).filter(f => f.endsWith(".test.mjs")).sort();

const results = [];
for (const suite of suites) {
  console.log(`\n${"=".repeat(60)}\n  ${suite}\n${"=".repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(dir, suite)], { stdio: "inherit" });
  results.push({ suite, ok: r.status === 0 });
}

console.log(`\n${"=".repeat(60)}\n  SUMMARY\n${"=".repeat(60)}`);
for (const { suite, ok } of results) console.log(`  ${ok ? "ok  " : "FAIL"}  ${suite}`);

const failed = results.filter(r => !r.ok).length;
console.log(failed ? `\n${failed} suite(s) failed` : `\nAll ${results.length} suites passed`);
process.exit(failed ? 1 : 0);
