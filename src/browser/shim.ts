import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";
import { FrameBases, resolveBigFrame, type BigFrameMeta } from "./frame-delta";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | { type: "codex-web-open-window"; windowId: number; path: string }
  | { type: "codex-web-close-window"; windowId: number }
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

const RECONNECT_DELAY_MS = 1_000;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  // Origin of our own copy of the MCP App sandbox shell (see
  // src/server/main.ts startMcpSandboxServer). Patched renderer code renders
  // MCP App widgets in an <iframe> on this origin instead of an Electron
  // <webview> on codex-sandbox://*.web-sandbox.oaiusercontent.com.
  mcpAppSandboxOrigin?: string;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
    getLayerOverride?: (
      layer: StatsigLayerEvaluation,
      ...args: unknown[]
    ) => StatsigLayerEvaluation | null;
  };
};

type StatsigLayerEvaluation = {
  name: string;
  __value?: Record<string, unknown>;
  [key: string]: unknown;
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

// Phone layout for the app shell's navigation rail (26.924+): with the sidebar
// closed the rail strip is hidden and the chat goes edge to edge; opening the
// sidebar shows rail + list full screen (see webview-mobile.patch).
const mobileShellStyle = document.createElement("style");
mobileShellStyle.dataset.codexWeb = "mobile-shell";
mobileShellStyle.textContent = `
@media (max-width: 767.98px) {
  [data-app-shell-frame][data-app-shell-sidebar-open="false"] {
    --app-shell-navigation-rail-width: 0px !important;
  }
  [data-app-shell-frame][data-app-shell-sidebar-open="false"] aside.app-shell-left-panel {
    display: none !important;
  }
  [data-app-shell-frame],
  [data-app-shell-frame] > * {
    padding-right: 0 !important;
    padding-bottom: 0 !important;
  }
  [data-app-shell-frame] main[data-app-shell-main-surface] {
    border-radius: 0 !important;
  }
  /* No home-indicator band under the chat: the composer sits on the bottom
     edge (webview-mobile.patch pads #root by the safe areas). An open
     sidebar keeps the padding for its bottom controls. */
  #root:has([data-app-shell-frame][data-app-shell-sidebar-open="false"]) {
    padding-bottom: 0 !important;
  }
  /* The sidebar's sortable rows (threads, projects, rail) are touch-none for
     drag and drop, so a swipe starting on a row never scrolled the list.
     Touch never starts a drag on phones (webview-mobile-touch-no-drag.patch). */
  aside.app-shell-left-panel .touch-none {
    touch-action: manipulation !important;
  }
}`;
document.head.append(mobileShellStyle);

// On iPhones a menu opened by a tap (e.g. the composer's "This computer"
// picker) closed again at once: the layer took a follow-up event of the same
// tap for an interaction outside it. Emulated WebKit/Chrome don't reproduce
// it, so ignore outside-dismissals for a moment after a touch opens a popup.
const POPUP_TRIGGER = '[aria-haspopup="menu"],[aria-haspopup="listbox"],[aria-haspopup="dialog"],[aria-haspopup="true"]';
const TOUCH_OPEN_GRACE_MS = 600;
let popupTouchAt = -Infinity;
document.addEventListener(
  "pointerdown",
  (event) => {
    if (event.pointerType !== "touch") return;
    if (!(event.target instanceof Element) || !event.target.closest(POPUP_TRIGGER)) return;
    popupTouchAt = performance.now();
  },
  true,
);
for (const type of ["dismissableLayer.pointerDownOutside", "dismissableLayer.focusOutside"]) {
  window.addEventListener(
    type,
    (event) => {
      if (performance.now() - popupTouchAt < TOUCH_OPEN_GRACE_MS) event.preventDefault();
    },
    true,
  );
}

// Instant paint (a stored picture of the last screen) was removed on
// 2026-09-30: it looked interactive while the app was still booting. Drop the
// snapshots it saved; they can hold chat content.
try {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("codex-web:instant-paint:")) localStorage.removeItem(key);
  }
} catch {}

// The app's secondary windows (realtime voice overlay) run hidden in this tab
// so their mic capture and audio playback use this device.
const hostedWindowFrames = new Map<number, HTMLIFrameElement>();

// The app opens its overlay window at startup, but booting a second app view
// in an iframe doubles startup work on phones. Only host it once voice is used.
const pendingHostedWindows = new Map<number, string>();
let voiceRequested = false;

function requestHostedWindow(windowId: number, path: string): void {
  if (voiceRequested) {
    openHostedWindow(windowId, path);
    return;
  }
  pendingHostedWindows.set(windowId, path);
}

function noteOutgoingFrame(frame: string): void {
  if (voiceRequested || !frame.includes('"requestRealtimeStart"')) return;
  voiceRequested = true;
  for (const [windowId, path] of pendingHostedWindows) openHostedWindow(windowId, path);
  pendingHostedWindows.clear();
}

function openHostedWindow(windowId: number, path: string): void {
  if (hostedWindowFrames.has(windowId)) return;
  const frame = document.createElement("iframe");
  frame.src = path;
  frame.allow = "microphone; autoplay; camera; clipboard-write";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none;";
  hostedWindowFrames.set(windowId, frame);
  document.body.append(frame);
}

function closeHostedWindow(windowId: number): void {
  pendingHostedWindows.delete(windowId);
  hostedWindowFrames.get(windowId)?.remove();
  hostedWindowFrames.delete(windowId);
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "codex-web-open-window") {
    requestHostedWindow(message.windowId, message.path);
    return;
  }

  if (message.type === "codex-web-close-window") {
    closeHostedWindow(message.windowId);
    return;
  }

  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

// Resumable transport. Phones drop the WebSocket whenever the tab is
// backgrounded; the server keeps this app view's session alive, so we reconnect
// with its id and replay unacknowledged frames instead of reloading the page.
let sessionId: string | null = null;
let handshakeDone = false;
let outSeq = 0;
// Always the whole frame: replays after a reconnect never use deltas.
const unackedOut: { seq: number; frame: string }[] = [];
const frameBases = new FrameBases();

// Identifies this view so the server keeps one backend view per tab (per
// app, in the iOS app's single web view) instead of piling up views from old
// page loads. Per tab, not per browser: sibling tabs must not evict each other.
function viewClientId(): string {
  const inPhoneApp = Boolean(
    (window as { webkit?: { messageHandlers?: Record<string, unknown> } }).webkit?.messageHandlers?.codexAnywhereRTC,
  );
  const key = "codexWebClientId";
  try {
    const storage = inPhoneApp ? localStorage : sessionStorage;
    const existing = storage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    storage.setItem(key, created);
    return created;
  } catch {
    return "";
  }
}
const clientId = viewClientId();
let lastServerSeq = 0;
let ackTimeoutId: number | null = null;
let reconnectAttempts = 0;
let pingTimeoutId: number | null = null;

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || !handshakeDone) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    const seq = ++outSeq;
    const messageJson = JSON.stringify(message);
    const frame = `{"s":${seq},"m":${messageJson}}`;
    unackedOut.push({ seq, frame });
    noteOutgoingFrame(frame);
    socket.send(frameBases.encodeOutgoing(seq, messageJson) ?? frame);
  }
}

function trimUnackedOut(ack: number): void {
  let drop = 0;
  while (drop < unackedOut.length && unackedOut[drop]!.seq <= ack) drop += 1;
  if (drop > 0) unackedOut.splice(0, drop);
}

function scheduleAck(): void {
  if (ackTimeoutId !== null) return;
  ackTimeoutId = window.setTimeout(() => {
    ackTimeoutId = null;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ ack: lastServerSeq }));
    }
  }, 250);
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  const delay = Math.min(RECONNECT_DELAY_MS, 100 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, delay);
}

function reconnectNow(): void {
  if (reconnectTimeoutId !== null) {
    window.clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  reconnectAttempts = 0;
  ensureSocket();
}

// Coming back to a backgrounded tab: the socket may look open but be dead.
// After a real absence (phone app suspended, tab in the background) it almost
// always is, so reconnect right away instead of waiting out a ping timeout.
let hiddenSince: number | null = null;
let lastReceiveAt = 0;
const LONG_ABSENCE_MS = 5_000;
function checkConnection(): void {
  if (document.visibilityState !== "visible") {
    hiddenSince ??= Date.now();
    return;
  }
  const wasAwayLong = hiddenSince !== null && Date.now() - hiddenSince > LONG_ABSENCE_MS;
  hiddenSince = null;
  if (wasAwayLong && socket && socket.readyState === WebSocket.OPEN && handshakeDone) {
    const stale = socket;
    socket = null;
    handshakeDone = false;
    if (pingTimeoutId !== null) {
      window.clearTimeout(pingTimeoutId);
      pingTimeoutId = null;
    }
    stale.close();
    reconnectNow();
    return;
  }
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    reconnectNow();
    return;
  }
  if (socket.readyState !== WebSocket.OPEN || pingTimeoutId !== null) return;
  const probe = socket;
  const sentAt = Date.now();
  probe.send(JSON.stringify({ ping: sentAt }));
  const awaitPong = (buffered: number) => {
    pingTimeoutId = window.setTimeout(() => {
      pingTimeoutId = null;
      if (socket !== probe) return;
      // Traffic since the ping (e.g. chunks of a big frame the pong is queued
      // behind) means it is busy, not dead: keep waiting for the pong, but not
      // forever, in case only our direction died.
      if (lastReceiveAt >= sentAt && Date.now() - sentAt < 30_000) {
        awaitPong(probe.bufferedAmount + 1);
        return;
      }
      // Still draining a big upload of ours: slow, not dead.
      if (probe.bufferedAmount > 0 && probe.bufferedAmount < buffered) {
        awaitPong(probe.bufferedAmount);
        return;
      }
      probe.close();
      // Closing a dead socket may not fire "close" promptly; move on now.
      socket = null;
      handshakeDone = false;
      reconnectNow();
    }, 3_000);
  };
  awaitPong(probe.bufferedAmount + 1);
}

// Network switches (Wi-Fi <-> cellular) can leave the socket half-open with no
// close event, so probe it regularly while the page is visible.
window.setInterval(checkConnection, 5_000);
document.addEventListener("visibilitychange", checkConnection);
window.addEventListener("pageshow", checkConnection);
window.addEventListener("online", checkConnection);
window.addEventListener("focus", checkConnection);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") frameBases.flush();
});
window.addEventListener("pagehide", (event) => {
  frameBases.flush();
  // A real unload (close, reload, navigate) frees the server session now.
  if (!event.persisted && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ bye: true }));
  }
});

function declareFrameBases(): void {
  if (!frameBases.enabled) return;
  const current = socket;
  void frameBases.loaded.then(() => {
    if (socket !== current || current?.readyState !== WebSocket.OPEN) return;
    current.send(JSON.stringify({ bases: frameBases.declared(), at: lastServerSeq }));
  });
}

type IncomingFrame = {
  hello?: { session?: string; resumed?: boolean; resumeFailed?: boolean; lastClientSeq?: number };
  s?: number;
  m?: MainToRendererMessage;
  b?: BigFrameMeta;
  d?: unknown;
  p?: number[];
  ack?: number;
  pong?: unknown;
  basesOk?: unknown;
};

function handleFrame(data: IncomingFrame, raw: string): void {
  if (data.hello) {
    if (data.hello.resumeFailed || (sessionId !== null && !data.hello.resumed)) {
      // The server no longer has this app view; only a fresh one can recover.
      window.location.reload();
      return;
    }
    sessionId = data.hello.session ?? sessionId;
    trimUnackedOut(data.hello.lastClientSeq ?? 0);
    handshakeDone = true;
    reconnectAttempts = 0;
    for (const { frame } of unackedOut) socket?.send(frame);
    flushOutboundQueue();
    if (!data.hello.resumed) declareFrameBases();
    return;
  }
  if (data.basesOk !== undefined) {
    frameBases.acceptServerKnown(data.basesOk);
    return;
  }
  if (typeof data.ack === "number") {
    trimUnackedOut(data.ack);
    return;
  }
  if (data.pong !== undefined) {
    if (pingTimeoutId !== null) {
      window.clearTimeout(pingTimeoutId);
      pingTimeoutId = null;
    }
    return;
  }
  if (typeof data.s !== "number") return;
  if (data.s <= lastServerSeq) return; // replayed after a resume
  let message = data.m;
  if (data.b) {
    try {
      message = resolveBigFrame(frameBases, raw, data as Parameters<typeof resolveBigFrame>[2]) as MainToRendererMessage;
    } catch (error) {
      FrameBases.recoverFromFailure(error);
      return;
    }
  }
  if (message == null) return;
  lastServerSeq = data.s;
  scheduleAck();
  handleIncomingMessage(message);
}

// The server refuses the socket handshake (no close code reaches the page)
// once this device is unpaired, e.g. after a server update added the device
// gate or the cookie was cleared. Ask it directly, and reload into the
// pairing page if so.
let lastPairingCheckAt = 0;
function checkStillPaired(): void {
  if (Date.now() - lastPairingCheckAt < 10_000) return;
  lastPairingCheckAt = Date.now();
  void fetch("/__auth/status", { cache: "no-store", credentials: "same-origin" })
    .then((response) => {
      if (response.status === 401) window.location.reload();
    })
    .catch(() => {});
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const params = new URLSearchParams();
  const hostedWindowId = new URLSearchParams(window.location.search).get(
    "codexWebWindow",
  );
  if (hostedWindowId) params.set("attachWindow", hostedWindowId);
  if (sessionId) {
    params.set("session", sessionId);
    params.set("ack", String(lastServerSeq));
  }
  if (clientId && !hostedWindowId) params.set("client", clientId);
  params.set("ck", "1");
  // Big-frame deltas (see frame-delta.ts); older pages never ask, so never get them.
  if (frameBases.enabled) params.set("fd", "1");
  const query = params.toString();
  handshakeDone = false;
  const current = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc${query ? `?${query}` : ""}`,
  );
  socket = current;
  let opened = false;
  current.addEventListener("open", () => {
    opened = true;
  });
  // Chunked big frames from the server (see sendRaw in main.ts); a reconnect
  // gets the whole frame replayed, so partial ones die with their socket.
  const chunks = new Map<string, string[]>();
  current.addEventListener("message", (event) => {
    if (socket !== current) return;
    lastReceiveAt = Date.now();
    try {
      let raw = String(event.data);
      if (raw.charCodeAt(0) === 1) {
        const newline = raw.indexOf("\n");
        const [id = "", index, total] = raw.slice(1, newline).split(" ");
        const parts = chunks.get(id) ?? [];
        parts[Number(index)] = raw.slice(newline + 1);
        chunks.set(id, parts);
        if (parts.filter((part) => part !== undefined).length < Number(total)) return;
        chunks.delete(id);
        raw = parts.join("");
      }
      handleFrame(JSON.parse(raw), raw);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  current.addEventListener("close", (event) => {
    // 4000: the server could not decode one of our deltas.
    if (event.code === 4000) frameBases.forgetServerKnown();
    // 4401: this device was revoked; the reload shows the pairing page.
    if (event.code === 4401) {
      window.location.reload();
      return;
    }
    if (!opened) checkStillPaired();
    if (socket !== current) return;
    handshakeDone = false;
    if (pingTimeoutId !== null) {
      window.clearTimeout(pingTimeoutId);
      pingTimeoutId = null;
    }
    if (document.visibilityState === "visible") scheduleReconnect();
  });
  current.addEventListener("error", () => {
    if (socket !== current) return;
    if (document.visibilityState === "visible") scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations" ||
    path === "/plugins" ||
    path.startsWith("/plugins/") ||
    path.startsWith("/mcp-app/")
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isPickWorkspaceRootOptionMessage(value: unknown): value is {
  type: "electron-pick-workspace-root-option";
} {
  return (
    isRecord(value) && value.type === "electron-pick-workspace-root-option"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 767.98px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

// Plugin pages run someone else's code in an iframe of this page. The iOS
// app's native handlers (microphone, logs) answered every frame before build
// 2; such a build has its handlers but not the main-frame marker, so pages
// stay off there (they render blank) until the app is updated. Browsers and
// the home-screen web app have no native handlers and get pages.
const pluginPagesAllowed = (() => {
  const handlers = (window as { webkit?: { messageHandlers?: Record<string, unknown> } }).webkit?.messageHandlers;
  const nativeApp = handlers != null && handlers.codexAnywhereRTC != null;
  return !nativeApp || (window as { __codexAnywhereFrameGuard?: number }).__codexAnywhereFrameGuard === 1;
})();

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    return null;
  },
  getLayerOverride(layer) {
    if (layer.name === "2138468235" && pluginPagesAllowed) {
      // MCP Apps inside threads (inline widgets, thread panels). The global
      // sidebar page renders without it. Also forwarded to the app-server as
      // the `enable_mcp_apps` feature.
      return { ...layer, __value: { ...(layer.__value ?? {}), enable_mcp_apps: true } };
    }
    return null;
  },
};

// The sandbox shell is served on the next port of the same host, a separate
// origin from the app (an iframe on the app's own origin could reach the
// app's DOM). Behind `tailscale serve`, serve that port too.
if (pluginPagesAllowed) {
  electronShim.mcpAppSandboxOrigin = (() => {
    const port = Number(window.location.port || (window.location.protocol === "https:" ? 443 : 80));
    return `${window.location.protocol}//${window.location.hostname}:${port + 1}`;
  })();
}

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }

      // The "Create project" dialog asks main for a native folder picker and
      // waits for a workspace-root-option-picked message; answer it locally.
      if (isPickWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (root) {
            emitRendererEvent("codex_desktop:message-for-view", [
              { type: "workspace-root-option-picked", root },
            ]);
          }
          return undefined;
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};
