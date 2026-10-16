// Captures the big socket frames of two page loads (statsig payloads) as
// fixtures for frame-delta.test.mjs and frame-protocol.test.mjs. They contain
// account ids: keep them out of the repo.
//
//   node test/capture-big-frames.mjs <out dir>
// Env: U (base URL), PLAYWRIGHT_CORE. Loads with plain frames (no deltas) so
// every big payload arrives whole. Read-only: navigates by URL, never clicks.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localDeviceCookies } from "../scripts/lib/local-cookie.mjs";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core"].filter(Boolean);
  const npxRoot = path.join(os.homedir(), ".npm/_npx");
  if (fs.existsSync(npxRoot)) {
    for (const dir of fs.readdirSync(npxRoot)) candidates.push(path.join(npxRoot, dir, "node_modules/playwright-core"));
  }
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error("playwright-core not found");
}
const { chromium } = loadPlaywright();
const outDir = process.argv[2];
if (!outDir) throw new Error("usage: capture-big-frames.mjs <out dir>");
fs.mkdirSync(outDir, { recursive: true });
const base = process.env.U ?? "http://127.0.0.1:8200";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-anywhere-capture-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true });
await ctx.addCookies(localDeviceCookies(base));
await ctx.addInitScript(() => {
  // Plain frames: turn off deltas for this tab so payloads arrive whole.
  sessionStorage.setItem("codexWebFrameDeltaDisabled", "1");
  window.__big = [];
  const Original = window.WebSocket;
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      const chunks = new Map();
      this.addEventListener("message", (event) => {
        let raw = String(event.data);
        if (raw.charCodeAt(0) === 1) {
          const newline = raw.indexOf("\n");
          const [id, index, total] = raw.slice(1, newline).split(" ");
          const parts = chunks.get(id) ?? [];
          parts[Number(index)] = raw.slice(newline + 1);
          chunks.set(id, parts);
          if (parts.filter((part) => part !== undefined).length < Number(total)) return;
          raw = parts.join("");
        }
        if (raw.length > 1e6) window.__big.push(raw);
      });
    }
  };
});
for (let load = 0; load < 2; load += 1) {
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.waitForTimeout(8000);
  const frames = await page.evaluate(() => window.__big);
  frames.forEach((frame, index) => fs.writeFileSync(path.join(outDir, `big-${load}-${index}.json`), frame));
  console.log(`load ${load}: ${frames.map((frame) => frame.length).join(", ")}`);
  await page.close();
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
