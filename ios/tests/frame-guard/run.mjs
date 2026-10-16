#!/usr/bin/env node
// Frame-guard test for the iOS app, in real WebKit (a macOS WKWebView).
//
// Serves two origins on 127.0.0.1: the "app" (a main page plus a same-origin
// voice-window iframe) and the "sandbox" on the next port (a hostile plugin
// page in an iframe, sandboxed like the app sandboxes plugin pages). Then it
// compiles main.swift with the app's FrameGuard.swift and checks:
//   - the voice iframe runs a whole call through the main frame's handler and
//     gets every event back through the main frame's router;
//   - the hostile page is refused by the RTC, log and ready handlers, cannot
//     reach `top.webkit` or the router, and does not see the marker that tells
//     the web app plugin pages are safe here.
//
// macOS only (needs Xcode's swiftc). Usage: node ios/tests/frame-guard/run.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../CodexAnywhere");
const PROTECTED_PORTS = new Set([7777, 7788, 7850, 7860, 7877, 8000, 8200, 8201, 18790]);

async function freePortPair() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer().once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    if (PROTECTED_PORTS.has(port) || PROTECTED_PORTS.has(port + 1)) continue;
    const nextFree = await new Promise((resolve) => {
      const probe = net.createServer().once("error", () => resolve(false));
      probe.listen(port + 1, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (nextFree) return port;
  }
}

const mainPage = (sandboxPort) => `<!doctype html><title>main</title><body>
<script>
window.__results = { main: {}, voice: null, hostile: null };
window.__results.main.marker = window.__codexAnywhereFrameGuard === 1;
window.__results.main.rtcUntouched = /native code/.test(String(window.RTCPeerConnection));
window.__results.main.router = typeof window.__codexAnywhereRTC?.dispatch === "function";
addEventListener("message", (e) => { if (e.data && e.data.hostile) window.__results.hostile = e.data.hostile; });
const voice = document.createElement("iframe");
voice.src = "/voice?codexWebWindow=1";
document.body.append(voice);
const hostile = document.createElement("iframe");
hostile.src = "http://127.0.0.1:${sandboxPort}/hostile?codexWebWindow=1";
hostile.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
hostile.allow = "microphone *";
document.body.append(hostile);
console.error("main-frame log line");
</script></body>`;

const voicePage = `<!doctype html><title>voice</title><body><script>
(async () => {
  const r = { marker: window.__codexAnywhereFrameGuard === 1, bridged: !/native code/.test(String(window.RTCPeerConnection)), events: [] };
  try {
    const pc = new RTCPeerConnection();
    pc.onconnectionstatechange = () => r.events.push("connectionState:" + pc.connectionState);
    pc.ontrack = (e) => r.events.push("track:" + (e.track && e.track.kind));
    const dc = pc.createDataChannel("oai-events");
    dc.onopen = () => r.events.push("dcOpen");
    dc.onmessage = (e) => r.events.push("dcMessage:" + e.data);
    const offer = await pc.createOffer();
    r.offer = offer.sdp;
    await pc.setLocalDescription(offer);
    await pc.setRemoteDescription({ type: "answer", sdp: "fake-answer" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    dc.send("hello from voice");
    await new Promise((resolve) => setTimeout(resolve, 300));
    pc.close();
    console.error("voice-frame log line");
  } catch (error) {
    r.error = String(error && error.message || error);
  }
  top.__results.voice = r;
})();
</script></body>`;

const hostilePage = `<!doctype html><title>hostile</title><body><script>
(async () => {
  const r = {};
  const h = window.webkit && window.webkit.messageHandlers;
  r.ownHandlersVisible = !!(h && h.codexAnywhereRTC);
  r.marker = window.__codexAnywhereFrameGuard === 1;
  r.bridgedHere = !/native code/.test(String(window.RTCPeerConnection));
  try { r.topWebkit = typeof top.webkit; } catch (e) { r.topWebkit = "threw " + e.name; }
  try { r.topRouter = typeof top.__codexAnywhereRTC; } catch (e) { r.topRouter = "threw " + e.name; }
  try {
    await h.codexAnywhereRTC.postMessage({ op: "create", pcId: "evil" });
    r.rtcCreate = "accepted";
  } catch (e) { r.rtcCreate = "rejected: " + (e && e.message); }
  try { h.codexAnywhereLog.postMessage("EVIL LOG LINE"); r.logPosted = true; } catch (e) { r.logPosted = "threw"; }
  try { h.codexAnywhereReady.postMessage({ source: "evil", path: "/" }); r.readyPosted = true; } catch (e) { r.readyPosted = "threw"; }
  parent.postMessage({ hostile: r }, "*");
})();
</script></body>`;

const serve = (port, routes) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = routes[new URL(req.url, "http://x").pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? "not found");
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

const port = await freePortPair();
const servers = [
  await serve(port, { "/": mainPage(port + 1), "/voice": voicePage }),
  await serve(port + 1, { "/hostile": hostilePage }),
];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "codex-anywhere-frame-guard-"));
let report;
try {
  const binary = path.join(work, "harness");
  execFileSync("swiftc", ["-O", "-o", binary, path.join(here, "main.swift"), path.join(app, "FrameGuard.swift"), "-framework", "WebKit", "-framework", "AppKit"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  // The harness needs the servers above, so it runs as a child process.
  report = await new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(binary, [`http://127.0.0.1:${port}/`, path.join(app, "rtc-bridge.js"), path.join(app, "web-log.js")], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`harness exited ${code} without a report:\n${out}`));
      }
    });
  });
} finally {
  for (const server of servers) server.close();
  fs.rmSync(work, { recursive: true, force: true });
}

const { page } = report;
const app_ = `http://127.0.0.1:${port}`;
const criteria = {
  "main frame: marker set, router present, RTCPeerConnection untouched": page.main.marker === true && page.main.router === true && page.main.rtcUntouched === true,
  "voice iframe: whole call through the main frame": page.voice?.bridged === true &&
    JSON.stringify(page.voice.events) === JSON.stringify(["connectionState:connected", "track:audio", "dcOpen", "dcMessage:hello from native"]) &&
    page.voice.offer === "fake-offer" &&
    ["create", "createDataChannel", "createOffer", "setLocalDescription", "setRemoteDescription", "dcSend", "close"].every((op) =>
      report.rtcAccepted.includes(`rtc ${op} from main ${app_}`)),
  "voice iframe: logs arrive as the main frame": report.logAccepted.some((line) => line.includes("[sub /voice?codexWebWindow=1] voice-frame log line")),
  "hostile page: RTC refused": page.hostile?.rtcCreate === "rejected: refused" && report.rtcRefused.length === 1 && report.rtcAccepted.every((line) => line.includes(`from main ${app_}`)),
  "hostile page: log and ready refused": report.logRefused.length === 1 && report.readyRefused.length === 1 && report.readyAccepted.length === 0 &&
    !report.logAccepted.some((line) => line.includes("EVIL")),
  "hostile page: cannot reach top.webkit or the router": /^threw/.test(page.hostile?.topWebkit) && /^threw/.test(page.hostile?.topRouter),
  "hostile page: no marker": page.hostile?.marker === false,
};
if (process.env.VERBOSE) console.log(JSON.stringify(report, null, 2));
for (const [name, ok] of Object.entries(criteria)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
process.exitCode = Object.values(criteria).every(Boolean) ? 0 : 1;
