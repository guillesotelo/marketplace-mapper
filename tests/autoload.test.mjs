// The auto-load sweep: it must stop when asked, stop when the user scrolls,
// and always stop on its own. Driven against a fake window so the timing is
// deterministic and the whole suite still runs in seconds.
import fs from "fs";
import path from "path";
import { EXT, makeChecker } from "./lib.mjs";

const { check, state } = makeChecker();

const src = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const block = src.slice(src.indexOf("let autoScrollRunning = false;"), src.indexOf("function injectMap()"));

// Read the caps from the source rather than hardcoding them, so tuning the
// sweep length is a one-line change that doesn't break this suite.
const constant = (name) => Number(src.match(new RegExp(`const ${name} = (\\d+)`))?.[1]);
const SWEEP_MAX_MS = constant("SWEEP_MAX_MS");
const SWEEP_MAX_STEPS = constant("SWEEP_MAX_STEPS");
console.log(`(sweep caps: ${SWEEP_MAX_MS}ms / ${SWEEP_MAX_STEPS} steps)`);

function makeEnv({ pageHeight = 20000, grows = false } = {}) {
  const listeners = {};
  const posted = [];
  const env = {
    scrollY: 0,
    innerHeight: 900,
    _height: pageHeight,
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
    scrollBy: (x, y) => {
      env.scrollY = Math.min(env.scrollY + y, env._height - env.innerHeight);
    },
    scrollTo: ({ top }) => { env.scrollY = top; },
    fire: (t, ev = {}) => (listeners[t] || []).forEach(f => f(ev)),
    posted,
    listenerCount: () => Object.values(listeners).reduce((a, b) => a + b.length, 0),
    stopGrowing: () => clearInterval(env._grower),
  };

  // A real lazy-loading feed keeps appending on its own clock, not only when
  // we scroll — so the page must keep growing during waitForPageGrowth too,
  // otherwise the sweep bails early for reasons the real site wouldn't cause.
  if (grows) env._grower = setInterval(() => { env._height += 300; }, 100);
  const document = {
    body: { get scrollHeight() { return env._height; } },
    getElementById: () => ({ contentWindow: { postMessage: m => posted.push(m) } }),
  };
  const location = { href: "https://facebook.com/marketplace/oslo", pathname: "/marketplace" };
  return { env, document, location };
}

const load = ({ env, document, location }) => new Function(
  "window", "document", "location", "setTimeout", "clearTimeout", "Date",
  block + "\nreturn { runAutoScrollSweep, cancelAutoScrollSweep, running: () => autoScrollRunning };"
)(env, document, location, setTimeout, clearTimeout, Date);

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log("=== Toggling the tool off ===");
{
  const b = makeEnv();
  const api = load(b);
  const p = api.runAutoScrollSweep();
  await sleep(1000);
  const mid = b.env.scrollY;
  api.cancelAutoScrollSweep(true);
  await p;
  check("sweep stops", api.running() === false);
  check("it had been scrolling", mid > 0);
  check("original scroll position restored", b.env.scrollY === 0);
  check("all page listeners removed", b.env.listenerCount() === 0);
  check("reports running:false", b.env.posted.at(-1).running === false);
}

console.log("\n=== The user takes over ===");
{
  const b = makeEnv();
  const api = load(b);
  const p = api.runAutoScrollSweep();
  await sleep(1000);
  b.env.fire("wheel");
  await p;
  check("a wheel gesture stops the sweep", api.running() === false);
  check("the page is left where the user put it", b.env.scrollY > 0);
  check("listeners cleaned up", b.env.listenerCount() === 0);
}
{
  const b = makeEnv();
  const api = load(b);
  const p = api.runAutoScrollSweep();
  await sleep(900);
  b.env.fire("keydown", { key: "ArrowUp" });
  await p;
  check("ArrowUp stops the sweep", api.running() === false && b.env.scrollY > 0);
}

console.log("\n=== It always ends by itself ===");
{
  const b = makeEnv({ pageHeight: 3000, grows: true });   // a feed that never ends
  const api = load(b);
  const t0 = Date.now();
  await api.runAutoScrollSweep();
  const secs = (Date.now() - t0) / 1000;
  b.env.stopGrowing();
  const capSecs = SWEEP_MAX_MS / 1000;
  console.log(`  endless feed swept for ${secs.toFixed(1)}s (cap ${capSecs}s)`);

  // One settle step of slack: the cap is checked at the top of each iteration
  check("terminates on its own within the cap", secs <= capSecs + 1.5,
    `${secs.toFixed(1)}s vs cap ${capSecs}s`);
  check("and sweeps for a useful length of time first", secs > capSecs * 0.5,
    `${secs.toFixed(1)}s vs cap ${capSecs}s`);
}

console.log("\n=== Bookkeeping ===");
{
  const b = makeEnv();
  const api = load(b);
  const p = api.runAutoScrollSweep();
  api.runAutoScrollSweep();
  api.runAutoScrollSweep();
  await sleep(600);
  check("overlapping starts don't stack sweeps", b.env.listenerCount() === 3);
  api.cancelAutoScrollSweep(true);
  await p;
}
{
  const b = makeEnv({ pageHeight: 8000 });
  const api = load(b);
  await api.runAutoScrollSweep();
  const prog = b.env.posted.filter(m => m.running).map(m => m.progress);
  check("progress is monotonic", prog.length > 1 && prog.every((v, i) => i === 0 || v >= prog[i - 1]));
  check("progress stays within 0..1", prog.every(v => v >= 0 && v <= 1));
}

console.log(state.fail ? `\n${state.fail} FAILURE(S)` : `\nAll ${state.pass} checks passed`);
process.exit(state.fail ? 1 : 0);
