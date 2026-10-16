// Load-time harness for codex-anywhere. Read-only: navigates by URL, never
// clicks (the UI is connected to real data).
//
//   node test/measure-load.mjs
// Env: U (base URL, default http://127.0.0.1:8200), THREAD (thread id for the thread
// runs), RUNS (warm runs, default 3), PHONE=1 (390x844 plus throttling LAT ms /
// DOWN bits/s), HOLD (ms to keep each page open after its milestone, default
// 300; use >=1500 so the page can save its frame bases), PROFILE (Chrome
// profile dir, wiped first), PLAYWRIGHT_CORE (path to playwright-core;
// otherwise node_modules or the npx cache).
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
  throw new Error("playwright-core not found; run `npx -y playwright-core@latest --version` or set PLAYWRIGHT_CORE");
}
const { chromium } = loadPlaywright();
const BASE = process.env.U ?? "http://127.0.0.1:8200";
const THREAD = process.env.THREAD;
const RUNS = Number(process.env.RUNS ?? 3);
const PHONE = process.env.PHONE === "1";
const PROFILE = process.env.PROFILE ?? path.join(os.tmpdir(), "codex-anywhere-measure-profile");

const init = () => {
  const t = (window.__lt = { marks: {} });
  const mark = (k) => { if (t.marks[k] == null) t.marks[k] = Math.round(performance.now()); };
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(...a) {
      super(...a); mark("ws_new");
      this.addEventListener("open", () => mark("ws_open"));
      this.addEventListener("message", (e) => { mark("ws_first_msg"); t.wsIn = (t.wsIn ?? 0) + String(e.data).length; if (String(e.data).includes('"hello"')) mark("ws_hello"); });
      const send = this.send.bind(this); this.send = (d) => { t.wsOut = (t.wsOut ?? 0) + String(d).length; return send(d); };
    }
  };
  const check = () => {
    if (document.querySelector("[data-app-shell-frame]")) mark("shell");
    if (document.querySelector("[data-codex-composer]")) mark("composer");
    if (document.querySelectorAll("[data-thread-title]").length >= 5) mark("recents");
    const main = document.querySelector("main[data-app-shell-main-surface]");
    if (main && location.pathname.startsWith("/thread/")) {
      const len = main.innerText.length;
      if (len > 400) mark("thread_text");
    }
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener("DOMContentLoaded", () => mark("dcl"));
};

async function measure(ctx, url, label) {
  const page = await ctx.newPage();
  if (PHONE) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: Number(process.env.LAT ?? 95), downloadThroughput: Number(process.env.DOWN ?? 10e6) / 8, uploadThroughput: 5e6 / 8 });
  }
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "commit" });
  const want = url.includes("/thread/") ? "thread_text" : "recents";
  try {
    await page.waitForFunction((w) => window.__lt?.marks?.[w] != null, want, { timeout: 30000, polling: 50 });
  } catch { }
  await page.waitForTimeout(Number(process.env.HOLD ?? 300));
  const r = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    return {
      marks: window.__lt.marks, wsInKB: Math.round((window.__lt.wsIn ?? 0) / 1024), wsOutKB: Math.round((window.__lt.wsOut ?? 0) / 1024),
      html_ttfb: Math.round(nav.responseStart), html_done: Math.round(nav.responseEnd),
      nres: res.length,
      transferKB: Math.round(res.reduce((s, e) => s + (e.transferSize || 0), 0) / 1024),
      cached: res.filter((e) => e.transferSize === 0).length,
      lastRes: Math.round(Math.max(0, ...res.map((e) => e.responseEnd))),
    };
  });
  await page.close();
  return { label, ...r };
}

fs.rmSync(PROFILE, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: "chrome", headless: true, viewport: PHONE ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
await ctx.addInitScript(init);
await ctx.addCookies(localDeviceCookies(BASE));
const out = [];
out.push(await measure(ctx, `${BASE}/`, "home cold"));
for (let i = 0; i < RUNS; i++) out.push(await measure(ctx, `${BASE}/`, `home warm ${i + 1}`));
if (THREAD) for (let i = 0; i < RUNS; i++) out.push(await measure(ctx, `${BASE}/thread/${THREAD}`, `thread warm ${i + 1}`));
await ctx.close();
for (const r of out) console.log(JSON.stringify(r));
