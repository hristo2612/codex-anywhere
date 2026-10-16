#!/usr/bin/env node
// Contract test for ios/CodexAnywhere/rtc-bridge.js against the live server.
//
// Runs the web app in headless Chrome the way the iOS app hosts it:
//   1. a fake `window.webkit.messageHandlers.codexAnywhereRTC` in every frame
//      (WKScriptMessageHandlerWithReply: postMessage returns a Promise),
//   2. rtc-bridge.js itself as an all-frames, document-start user script.
// The "Swift" side (FakeSwiftBridge below) mirrors RTCBridge.swift op by op and
// runs each call on a real RTCPeerConnection in a separate browser context, so
// nothing it uses is touched by the bridge's patched globals. Like
// RTCBridge.swift it answers only the main frame of the app's origin
// (FrameGuard): the voice window posts through `top.webkit.messageHandlers`,
// and events go back through `window.__codexAnywhereRTC.dispatch(json)`
// evaluated in the main frame, exactly like
// `evaluateJavaScript(_:in: frame, in: .page)`. The main frame's router hands
// them to the voice window. (ios/tests/frame-guard/run.mjs checks the same
// routing in real WebKit, without a server.)
//
// Then it starts voice from the UI, checks the call, toggles mute from the UI,
// ends the call, and prints pass/fail per criterion. One run is one short voice
// session (a few cents of OpenAI usage).
//
// Usage:
//   node ios/tests/rtc-bridge-contract.mjs
// Env:
//   CODEX_ANYWHERE_URL   app URL (default http://127.0.0.1:8200/)
//   PLAYWRIGHT_CORE      path to a playwright-core package (auto-detected:
//                        node_modules, then the npx cache; populate it with
//                        `npx -y playwright-core@latest --version`)
//   CHROME_CHANNEL       Playwright channel (default "chrome" = installed Chrome)
//   HEADED=1             show the browser
//   OUT_DIR              where to write result.json and screenshots
//                        (default: $TMPDIR/codex-anywhere-rtc-contract)
//   SPEAK=0              use Chrome's default fake-mic tone instead of a
//                        spoken prompt (the prompt makes the model answer, which
//                        proves remote audio actually flows)

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDeviceCookies } from "../../scripts/lib/local-cookie.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_JS = path.resolve(here, "../CodexAnywhere/rtc-bridge.js");
const HANDLER_NAME = "codexAnywhereRTC"; // RTCBridge.handlerName
const APP_URL = process.env.CODEX_ANYWHERE_URL ?? "http://127.0.0.1:8200/";
const OUT_DIR = process.env.OUT_DIR ?? path.join(os.tmpdir(), "codex-anywhere-rtc-contract");
const VOICE_BUDGET_MS = 25_000; // hard cap on one voice session
fs.mkdirSync(OUT_DIR, { recursive: true });

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core", "playwright"].filter(Boolean);
  const npxRoot = path.join(os.homedir(), ".npm/_npx");
  if (fs.existsSync(npxRoot)) {
    for (const dir of fs.readdirSync(npxRoot)) {
      const pkg = path.join(npxRoot, dir, "node_modules/playwright-core");
      if (fs.existsSync(path.join(pkg, "package.json"))) candidates.push(pkg);
    }
  }
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error("playwright-core not found; run `npx -y playwright-core@latest --version` or set PLAYWRIGHT_CORE");
}

const t0 = Date.now();
const log = [];
function note(kind, detail) {
  const entry = { t: Date.now() - t0, kind, ...detail };
  log.push(entry);
  if (process.env.VERBOSE) console.log(JSON.stringify(entry));
}
const short = (value) => (typeof value === "string" && value.length > 120 ? `${value.slice(0, 60)}…(${value.length})` : value);

// ---------------------------------------------------------------------------
// Fake native side: RTCBridge.swift, op for op.
// ---------------------------------------------------------------------------

class BridgeError extends Error {}

class FakeSwiftBridge {
  constructor(nativePage) {
    this.native = nativePage; // plays the role of the WebRTC framework
    this.peers = new Map(); // pcId -> { frame }
  }

  // RTCBridge.emit(_:to:)
  emit(event, frame) {
    const json = JSON.stringify(event);
    note("emit", { type: event.type, state: event.state, data: short(event.data) });
    frame
      .evaluate(`window.__codexAnywhereRTC && window.__codexAnywhereRTC.dispatch(${json})`)
      .catch((error) => note("emit-failed", { error: String(error) }));
  }

  // Events from the real peer connection (Peer's delegate callbacks).
  onNativeEvent(event) {
    const peer = this.peers.get(event.pcId);
    if (!peer) return;
    this.emit(event, peer.frame);
  }

  // RTCBridge.handle(_:frame:), behind FrameGuard.isAppMainFrame.
  async handle(body, frame) {
    if (frame !== frame.page().mainFrame() || new URL(frame.url()).origin !== new URL(APP_URL).origin) {
      throw new BridgeError("refused");
    }
    const op = typeof body?.op === "string" ? body.op : null;
    const pcId = typeof body?.pcId === "string" ? body.pcId : null;
    if (!op || !pcId) throw new BridgeError("malformed message");
    if (op === "create") {
      if (this.peers.has(pcId)) await this.native.evaluate((id) => window.native.close(id), pcId);
      await this.native.evaluate((id) => window.native.create(id), pcId);
      this.peers.set(pcId, { frame });
      return null;
    }
    if (!this.peers.has(pcId)) {
      if (op === "close") return null;
      throw new BridgeError(`unknown peer ${pcId}`);
    }
    const n = this.native;
    switch (op) {
      case "createDataChannel":
        await n.evaluate(([id, label]) => window.native.createDataChannel(id, label), [pcId, typeof body.label === "string" ? body.label : "oai-events"]);
        return null;
      case "setMicEnabled":
        await n.evaluate(([id, enabled]) => window.native.setMicEnabled(id, enabled), [pcId, typeof body.enabled === "boolean" ? body.enabled : true]);
        return null;
      case "createOffer":
        return { sdp: await n.evaluate((id) => window.native.createOffer(id), pcId) };
      case "setLocalDescription":
      case "setRemoteDescription":
        if (typeof body.sdp !== "string") throw new BridgeError("missing sdp");
        await n.evaluate(
          ([id, local, type, sdp]) => window.native.setDescription(id, local, type, sdp),
          [pcId, op === "setLocalDescription", typeof body.type === "string" ? body.type : "offer", body.sdp],
        );
        return null;
      case "dcSend":
        await n.evaluate(([id, data]) => window.native.send(id, data), [pcId, typeof body.data === "string" ? body.data : ""]);
        return null;
      case "dcClose":
        await n.evaluate((id) => window.native.closeDataChannel(id), pcId);
        return null;
      case "close":
        await n.evaluate((id) => window.native.close(id), pcId);
        this.peers.delete(pcId);
        return null;
      default:
        throw new BridgeError(`unknown op ${op}`);
    }
  }
}

// Runs in the native page: the WebRTC framework stand-in (Peer in RTCBridge.swift).
function nativeRuntime() {
  const peers = new Map();
  const emit = (event) => window.__nativeEmit(event);
  window.native = {
    async create(id) {
      const pc = new RTCPeerConnection(); // RTCConfiguration(): unified plan, no ICE servers
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = mic.getAudioTracks()[0];
      pc.addTrack(track, mic); // connection.add(micTrack, streamIds:)
      const peer = { pc, track, channel: null, announcedTrack: false, closed: false, received: 0, sent: 0 };
      peers.set(id, peer);
      pc.onconnectionstatechange = () => emit({ pcId: id, type: "connectionState", state: pc.connectionState });
      pc.oniceconnectionstatechange = () => emit({ pcId: id, type: "iceConnectionState", state: pc.iceConnectionState });
      pc.ontrack = (event) => {
        // didStartReceivingOn transceiver: audio only, announced once
        if (event.track.kind !== "audio" || peer.announcedTrack) return;
        peer.announcedTrack = true;
        const audio = new Audio();
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        audio.play().catch(() => {});
        emit({ pcId: id, type: "track" });
      };
    },
    createDataChannel(id, label) {
      const peer = peers.get(id);
      const channel = peer.pc.createDataChannel(label); // RTCDataChannelConfiguration() defaults
      peer.channel = channel;
      channel.onopen = () => emit({ pcId: id, type: "dcOpen" });
      channel.onclose = () => emit({ pcId: id, type: "dcClose" });
      channel.onmessage = (event) => {
        peer.received += 1;
        const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        emit({ pcId: id, type: "dcMessage", data: text });
      };
    },
    setMicEnabled(id, enabled) {
      peers.get(id).track.enabled = enabled; // micTrack.isEnabled
    },
    async createOffer(id) {
      const offer = await peers.get(id).pc.createOffer();
      return offer.sdp;
    },
    async setDescription(id, local, type, sdp) {
      const pc = peers.get(id).pc;
      if (local) await pc.setLocalDescription({ type, sdp });
      else await pc.setRemoteDescription({ type, sdp });
    },
    send(id, text) {
      const peer = peers.get(id);
      // sendData on a channel that is not open just returns false
      if (peer.channel?.readyState === "open") {
        peer.channel.send(text);
        peer.sent += 1;
      }
    },
    closeDataChannel(id) {
      peers.get(id)?.channel?.close();
    },
    close(id) {
      const peer = peers.get(id);
      if (!peer || peer.closed) return;
      peer.closed = true;
      peer.channel?.close();
      peer.pc.close();
      peer.track.stop();
    },
    async stats(id) {
      const peer = peers.get(id);
      if (!peer) return null;
      const out = { connectionState: peer.pc.connectionState, dcSent: peer.sent, dcReceived: peer.received, micEnabled: peer.track.enabled };
      if (peer.pc.connectionState === "closed") return out;
      for (const report of (await peer.pc.getStats()).values()) {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          out.inboundAudio = { packetsReceived: report.packetsReceived, bytesReceived: report.bytesReceived, totalAudioEnergy: report.totalAudioEnergy };
        }
        if (report.type === "outbound-rtp" && report.kind === "audio") {
          out.outboundAudio = { packetsSent: report.packetsSent, bytesSent: report.bytesSent };
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Page-side injections, in WKUserScript order.
// ---------------------------------------------------------------------------

// WKWebView exposes window.webkit.messageHandlers.<name> in every frame of the
// page content world. With a reply handler, postMessage returns a Promise that
// resolves with the reply or rejects with Error(errorMessage).
const fakeWebkitScript = `(() => {
  const post = (message) => {
    let body;
    try { body = JSON.parse(JSON.stringify(message)); } catch (error) { return Promise.reject(error); }
    return window.__fakeNativePost(body);
  };
  window.webkit = { messageHandlers: { ${HANDLER_NAME}: { postMessage: post } } };
})();`;

// Test-only observation (never changes behaviour): records the bridge's peers,
// the events it dispatched and page errors, per frame.
const observerScript = `(() => {
  const probe = (window.__rtcProbe = { active: false, peers: [], dispatched: [], errors: [], trackEvents: 0 });
  window.addEventListener("error", (e) => probe.errors.push("error: " + (e.message || e.error)));
  window.addEventListener("unhandledrejection", (e) => probe.errors.push("unhandledrejection: " + (e.reason && (e.reason.message || e.reason))));
  const bridge = window.__codexAnywhereRTCFrame;
  if (!bridge) return;
  probe.active = true;
  const dispatch = bridge.dispatch.bind(bridge);
  bridge.dispatch = (event) => {
    probe.dispatched.push(event.type + (event.state ? ":" + event.state : ""));
    return dispatch(event);
  };
  const Bridged = window.RTCPeerConnection;
  class Observed extends Bridged {
    constructor(...args) {
      super(...args);
      probe.peers.push(this);
      this.addEventListener("track", (e) => { probe.trackEvents += 1; probe.lastTrack = { kind: e.track && e.track.kind, streams: e.streams && e.streams.length }; });
    }
  }
  window.RTCPeerConnection = Observed;
  window.webkitRTCPeerConnection = Observed;
})();`;

// ---------------------------------------------------------------------------

async function main() {
  const { chromium } = loadPlaywright();
  const args = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", // WKWebView: mediaTypesRequiringUserActionForPlayback = []
  ];
  if (process.env.SPEAK !== "0" && process.platform === "darwin") {
    // A spoken prompt for the native mic, after a pause for the call to connect.
    const wav = path.join(OUT_DIR, "prompt.wav");
    execFileSync("say", ["-o", wav, "--data-format=LEI16@48000", "[[slnc 5000]] Hi there. Please reply with one short sentence."]);
    args.push(`--use-file-for-fake-audio-capture=${wav}%noloop`);
  }
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: !process.env.HEADED, args });
  const results = {};
  const pageErrors = [];
  const consoleErrors = [];
  let app;
  let swift;
  try {
    // Native side: its own context, never sees the bridge or the fake handler.
    const nativeContext = await browser.newContext();
    const nativeUrl = new URL("/__codex_anywhere_fake_native__", APP_URL).href; // same origin => secure context
    await nativeContext.route(nativeUrl, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>fake native</title>" }));
    const nativePage = await nativeContext.newPage();
    swift = new FakeSwiftBridge(nativePage);
    await nativePage.exposeBinding("__nativeEmit", (_source, event) => swift.onNativeEvent(event));
    await nativePage.goto(nativeUrl);
    await nativePage.evaluate(nativeRuntime);

    // App side.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.exposeBinding("__fakeNativePost", async ({ frame }, body) => {
      note("op", { op: body?.op, label: body?.label, enabled: body?.enabled, type: body?.type, sdp: short(body?.sdp), data: short(body?.data), frame: frame.url().replace(/^https?:\/\/[^/]+/, "") });
      try {
        const reply = await swift.handle(body, frame);
        if (body?.op === "createOffer") note("reply", { op: "createOffer", sdp: short(reply.sdp) });
        return reply ?? undefined;
      } catch (error) {
        note("op-error", { op: body?.op, error: error.message });
        throw error;
      }
    });
    await context.addCookies(localDeviceCookies(APP_URL));
    await context.addInitScript({ content: fakeWebkitScript });
    await context.addInitScript({ path: BRIDGE_JS });
    await context.addInitScript({ content: observerScript });

    app = await context.newPage();
    app.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
    app.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${message.location()?.url?.includes("codexWebWindow") ? "[voice] " : ""}${message.text().slice(0, 200)}`);
    });

    // The server hands the app's single voice overlay window to one tab at a
    // time (codex-web-open-window). If another client holds it, voice cannot
    // start here; stop before spending a session.
    let overlayOffered = false;
    app.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload === "string" && payload.includes("codex-web-open-window")) overlayOffered = true;
      });
    });
    await app.goto(APP_URL, { waitUntil: "domcontentloaded" });
    const startButton = app.getByRole("button", { name: "Start new voice chat" });
    await startButton.waitFor({ timeout: 30_000 });
    await app.waitForTimeout(1500);
    for (let i = 0; i < 50 && !overlayOffered; i += 1) await app.waitForTimeout(200);
    // The overlay window may only be created once voice is requested, so a
    // missing offer here is a hint, not a failure; the voice checks decide.
    if (!overlayOffered) {
      console.warn("note: no voice overlay offered yet (created on first voice start, or another client holds it)");
    }
    results.mainFrameUntouched = await app.evaluate(
      () => typeof window.__codexAnywhereRTC?.dispatch === "function" && !window.__codexAnywhereRTCFrame && /native code/.test(String(window.RTCPeerConnection)),
    );

    const voiceStarted = Date.now();
    const deadline = voiceStarted + VOICE_BUDGET_MS;
    const remaining = () => Math.max(1000, deadline - Date.now());
    await startButton.click();
    note("ui", { action: "click Start new voice chat" });

    const waitFor = async (predicate, timeout = remaining()) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    };
    const has = (kind, match) => log.some((entry) => entry.kind === kind && Object.entries(match).every(([key, value]) => entry[key] === value));
    const voiceFrame = () => app.frames().find((frame) => frame.url().includes("codexWebWindow"));

    await waitFor(() => has("emit", { type: "connectionState", state: "connected" }) && has("emit", { type: "dcOpen" }) && has("emit", { type: "track" }));
    const frame = voiceFrame();
    const probe = async () => (frame ? frame.evaluate(() => {
      const p = window.__rtcProbe;
      const pc = p.peers.at(-1);
      return {
        active: p.active,
        peers: p.peers.length,
        connectionState: pc?.connectionState,
        iceConnectionState: pc?.iceConnectionState,
        channel: pc?.channel && { label: pc.channel.label, readyState: pc.channel.readyState },
        trackEvents: p.trackEvents,
        lastTrack: p.lastTrack,
        dispatched: p.dispatched.filter((type) => type !== "dcMessage"),
        dcMessages: p.dispatched.filter((type) => type === "dcMessage").length,
        errors: p.errors,
      };
    }) : null);

    // App-level voice state: the UI switches to the in-call controls once the
    // app marks the realtime session active (after WebRTC `connected`).
    const muteButton = app.getByRole("button", { name: "Mute microphone" });
    const unmuteButton = app.getByRole("button", { name: "Unmute microphone" });
    const endButton = app.getByRole("button", { name: /^(Stop|End) voice chat$/i });
    const appActive = await waitFor(async () => (await muteButton.count()) > 0 && (await endButton.count()) > 0);
    results.appActive = appActive;
    results.inCallButtons = await app.$$eval("button[aria-label]", (els) => els.map((el) => el.getAttribute("aria-label")).filter((label) => /voice|mute|microphone|end/i.test(label)));
    results.pageAfterConnect = await probe();
    await app.screenshot({ path: path.join(OUT_DIR, "in-call.png") });

    // Let the spoken prompt play and the model answer (remote audio).
    await waitFor(async () => {
      const s = await swift.native.evaluate((id) => window.native.stats(id), [...swift.peers.keys()].at(-1) ?? "");
      return (s?.inboundAudio?.totalAudioEnergy ?? 0) > 0.01;
    }, Math.min(12_000, remaining() - 8000));
    const pcId = [...swift.peers.keys()].at(-1);
    results.nativeStatsInCall = pcId ? await swift.native.evaluate((id) => window.native.stats(id), pcId) : null;

    // Page-side mute -> native mic.
    const micOps = () => log.filter((entry) => entry.kind === "op" && entry.op === "setMicEnabled").map((entry) => entry.enabled);
    const micOpsBefore = micOps().length;
    if (appActive) {
      await muteButton.first().click();
      note("ui", { action: "click Mute microphone" });
      await waitFor(() => micOps().slice(micOpsBefore).includes(false), 4000);
      results.nativeMicAfterMute = pcId ? (await swift.native.evaluate((id) => window.native.stats(id), pcId))?.micEnabled : null;
      await unmuteButton.first().waitFor({ timeout: 3000 }).catch(() => {});
      await unmuteButton.first().click().catch(() => {});
      note("ui", { action: "click Unmute microphone" });
      await waitFor(() => micOps().slice(micOpsBefore).lastIndexOf(true) > micOps().slice(micOpsBefore).indexOf(false) && micOps().slice(micOpsBefore).includes(false), 4000);
      results.nativeMicAfterUnmute = pcId ? (await swift.native.evaluate((id) => window.native.stats(id), pcId))?.micEnabled : null;
    }
    results.micOpsDuringCall = micOps().slice(micOpsBefore);

    // End voice.
    if ((await endButton.count()) > 0) {
      await endButton.first().click();
      note("ui", { action: "click Stop voice chat" });
    }
    await waitFor(() => has("op", { op: "close" }), 6000);
    const idleButton = app.getByRole("button", { name: /^Start (new )?voice chat$/i });
    const idle = await waitFor(async () => (await idleButton.count()) > 0 && (await muteButton.count()) === 0 && (await endButton.count()) === 0, 8000);
    results.voiceSessionMs = Date.now() - voiceStarted;
    results.backToIdle = idle;
    await app.waitForTimeout(1000);
    results.pageAfterEnd = await probe();
    results.nativeStatsAfterEnd = pcId ? await swift.native.evaluate((id) => window.native.stats(id), pcId) : null;
    await app.screenshot({ path: path.join(OUT_DIR, "after-end.png") });
  } finally {
    await browser.close().catch(() => {});
  }

  // -------------------------------------------------------------------------
  const ops = log.filter((entry) => entry.kind === "op").map((entry) => entry.op);
  const emits = log.filter((entry) => entry.kind === "emit" && entry.type !== "dcMessage").map((entry) => entry.type + (entry.state ? ":" + entry.state : ""));
  const at = (kind, match) => log.find((entry) => entry.kind === kind && Object.entries(match).every(([key, value]) => entry[key] === value));
  const opIndex = (op) => ops.indexOf(op);
  const page = results.pageAfterConnect ?? {};
  // Chrome reports this benign layout notice as a window error event.
  const benign = (message) => /ResizeObserver loop/.test(message);
  const voiceFrameErrors = [...new Set([...(page.errors ?? []), ...(results.pageAfterEnd?.errors ?? [])])].filter((message) => !benign(message));
  const mic = results.micOpsDuringCall ?? [];

  const criteria = {
    "bridge injected only in voice frame": results.mainFrameUntouched === true && page.active === true,
    "offer/answer": opIndex("create") >= 0 && opIndex("createDataChannel") > opIndex("create") && opIndex("createOffer") > opIndex("createDataChannel") &&
      opIndex("setLocalDescription") > opIndex("createOffer") && opIndex("setRemoteDescription") > opIndex("setLocalDescription") &&
      !log.some((entry) => entry.kind === "op-error" && ["create", "createDataChannel", "createOffer", "setLocalDescription", "setRemoteDescription"].includes(entry.op)),
    "oai-events data channel open": !!at("op", { op: "createDataChannel", label: "oai-events" }) && !!at("emit", { type: "dcOpen" }) &&
      page.channel?.label === "oai-events" && page.channel?.readyState === "open" && (page.dcMessages ?? 0) > 0,
    "page connectionState connected": page.connectionState === "connected" && page.dispatched?.includes("connectionState:connected"),
    "app voice state active (in-call UI)": results.appActive === true,
    "remote audio track": !!at("emit", { type: "track" }) && page.trackEvents === 1 && page.lastTrack?.kind === "audio" &&
      (results.nativeStatsInCall?.inboundAudio?.packetsReceived ?? 0) > 0,
    "mute reaches native mic": mic.includes(false) && mic.lastIndexOf(true) > mic.indexOf(false) && results.nativeMicAfterMute === false && results.nativeMicAfterUnmute === true,
    "end returns to idle": results.backToIdle === true && ops.includes("close") && results.nativeStatsAfterEnd?.connectionState === "closed",
    "no page errors": pageErrors.length === 0 && voiceFrameErrors.length === 0 && !consoleErrors.some((message) => message.includes("[codex-anywhere]")),
  };

  const summary = {
    url: APP_URL,
    criteria,
    evidence: {
      opSequence: ops.filter((op, i) => op !== "dcSend" || ops[i - 1] !== "dcSend"),
      dcSendCount: ops.filter((op) => op === "dcSend").length,
      nativeEvents: emits,
      dcMessagesToPage: log.filter((entry) => entry.kind === "emit" && entry.type === "dcMessage").length,
      firstServerEvents: log.filter((entry) => entry.kind === "emit" && entry.type === "dcMessage").slice(0, 3).map((entry) => String(entry.data).slice(0, 60)),
      timings: {
        createOfferMs: at("op", { op: "createOffer" })?.t,
        answerMs: at("op", { op: "setRemoteDescription" })?.t,
        connectedMs: at("emit", { type: "connectionState", state: "connected" })?.t,
        dcOpenMs: at("emit", { type: "dcOpen" })?.t,
      },
      ...results,
      nativeOpErrors: log.filter((entry) => entry.kind === "op-error").map((entry) => `${entry.op}: ${entry.error}`),
      pageErrors,
      voiceFrameErrors,
      consoleErrors: consoleErrors.slice(0, 20),
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ ...summary, log }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  for (const [name, ok] of Object.entries(criteria)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`\nfull log: ${path.join(OUT_DIR, "result.json")}`);
  process.exitCode = Object.values(criteria).every(Boolean) ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
