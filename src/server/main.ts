#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { FrameDeltaServer, newDeltaPeer, type DeltaPeer } from "./frame-delta";
import { DeviceGate, DeviceStore, refuseUpgrade, type Device, type PublicFile } from "./device-auth";
import { glob } from "glob";

type ServerOptions = {
  host: string;
  port: number;
};

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
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
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
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

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private readonly pendingMessages: unknown[] = [];
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    if (event === "message") {
      for (const data of this.pendingMessages.splice(0)) {
        this.receiveMessage(data);
      }
    }

    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {}

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      this.pendingMessages.push(data);
      return;
    }
    for (const listener of listeners) {
      listener({ data });
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.pendingMessages.length = 0;
    this.onClosed();
    return true;
  }
}

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type RendererWindow = {
  id: number;
  webContents: { id: number };
  destroy: () => void;
};

type IpcMainBridgeState = {
  setRendererWindowFactory?: (factory: () => Promise<RendererWindow>) => void;
  sendToRenderer?: (
    webContentsId: number,
    message: MainToRendererMessage,
  ) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    windowId: number,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => void;
  onWindowLoadURL?: (window: RendererWindow, url: string) => void;
  onWindowDestroyed?: (window: RendererWindow) => void;
  getWindowById?: (id: number) => RendererWindow | null;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8200",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8200,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    getSystemVersion?: () => string;
    resourcesPath?: string;
    type?: string;
  };
  const systemVersion =
    process.platform === "darwin"
      ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim()
      : os.release();
  processWithElectronFields.getSystemVersion ??= () => systemVersion;
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

// Browsers send every cookie of a host to every port, and a plugin page (on
// the sandbox port) can set cookies for this host. Node refuses requests with
// more than 16 KB of headers (431), so a page could lock devices out by
// setting a few big cookies. 1 MB covers a browser's whole per-host cookie
// jar.
const MAX_HEADER_BYTES = 1024 * 1024;

async function startIpcBridgeServer(options: ServerOptions): Promise<{ gate: DeviceGate }> {
  const bridgeState = getIpcMainBridgeState();

  // Prefer the minified + brotli copy from scripts/optimize_webview.mjs; the
  // formatted tree is ~30 MB per cold load, too slow for phones on a tailnet.
  const optimizedWebviewRoot = path.resolve(__dirname, "../../scratch/webview-dist");
  const webviewRoot = (await fs.stat(optimizedWebviewRoot).catch(() => null))
    ? optimizedWebviewRoot
    : path.resolve(__dirname, "../../scratch/asar/webview");

  // Every request and socket needs a paired device (see device-auth.ts). The
  // gate runs before Fastify, so nothing unauthenticated reaches a route.
  const deviceStore = new DeviceStore();
  deviceStore.ensureDir();
  deviceStore.refresh();
  if (deviceStore.error) console.error(`[device-auth] ${deviceStore.error}; every request is refused until it is fixed`);
  else if (deviceStore.devices().length === 0) {
    console.log("[device-auth] no devices paired yet; run `node scripts/pair.mjs --name <device>` on this machine");
  }
  // The PWA manifest and its icon are fetched without cookies.
  const publicFiles: Record<string, PublicFile> = {
    "/manifest.json": { file: path.join(webviewRoot, "manifest.json"), contentType: "application/manifest+json" },
    "/favicon.svg": { file: path.join(webviewRoot, "favicon.svg"), contentType: "image/svg+xml" },
    "/assets/pwa-icon-512.png": { file: path.join(webviewRoot, "assets/pwa-icon-512.png"), contentType: "image/png" },
  };
  const gate = new DeviceGate({
    store: deviceStore,
    publicFiles,
    allowedOrigins: (process.env.CODEX_ANYWHERE_ALLOWED_ORIGINS ?? "").split(","),
    publicHttps: process.env.CODEX_ANYWHERE_HTTPS === "1",
  });
  const app = Fastify({
    logger: false,
    serverFactory: (handler) =>
      http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
        if (gate.handleRequest(request, response)) return;
        handler(request, response);
      }),
  });
  // JSON compresses ~4-6x; phones reach us through a Tailscale relay.
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1 },
      threshold: 1024,
      concurrencyLimit: 4,
    },
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  // Local files for the app's own <img> tags. A file is never a live page on
  // this origin: an HTML or SVG file opened here (by a link, say) gets an
  // opaque origin with no scripts, so it cannot use the device cookie or the
  // app's socket, and the iOS app's handlers do not count it as the app.
  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  });

  // Content-hashed upstream assets never change under the same name, unless one
  // of our patches edits it, so those (and unhashed files) revalidate instead.
  const patchedWebviewFiles = new Set<string>();
  for (const patchFile of await glob(path.resolve(__dirname, "../../patches/*.patch"))) {
    for (const match of (await fs.readFile(patchFile, "utf8")).matchAll(
      /^\+\+\+ b\/webview\/(.+)$/gm,
    )) {
      if (match[1]) patchedWebviewFiles.add(match[1]);
    }
  }
  await app.register(fastifyStatic, {
    root: webviewRoot,
    prefix: "/",
    preCompressed: true,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const relative = path
        .relative(webviewRoot, filePath)
        .split(path.sep)
        .join("/")
        .replace(/\.(br|gz)$/, "");
      const immutable =
        relative.startsWith("assets/") &&
        /-[0-9a-f]{8,}\.[a-z0-9]+$/i.test(relative) &&
        !patchedWebviewFiles.has(relative);
      res.setHeader(
        "Cache-Control",
        immutable ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  // The device each accepted upgrade authenticated as, for its connection.
  const upgradeDevices = new WeakMap<object, Device>();
  app.server.on("upgrade", (request, socket, head) => {
    // A fixed base: a malformed Host header must not throw here (an uncaught
    // error would take the whole server, and every running turn, down).
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }
    // Same-origin page (no cross-site WebSocket hijacking) and a paired device.
    const decision = gate.authorizeUpgrade(request);
    if (!decision.ok) {
      refuseUpgrade(socket, decision.status);
      return;
    }

    upgradeDevices.set(request, decision.device);
    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  const rendererWindowFactory = new Promise<() => Promise<RendererWindow>>(
    (resolve) => {
      bridgeState.setRendererWindowFactory = resolve;
    },
  );

  // A session is one app view (tab or hosted iframe). It outlives its socket:
  // phones drop WebSockets whenever the tab is backgrounded, and rebooting the
  // app view costs seconds, so the tab resumes the session instead. Frames are
  // sequenced ({s, m}); unacknowledged ones are replayed on resume.
  type RendererSession = {
    id: string;
    // The paired device that opened it; only that device may resume it.
    deviceId: string;
    clientId: string | null;
    hostedWindowId: number | null;
    socket: WebSocket | null;
    window: RendererWindow | undefined;
    ready: Promise<RendererWindow | undefined>;
    messagePorts: Map<string, WebSocketMessagePort>;
    outSeq: number;
    outBuffer: { seq: number; frame: string }[];
    outBufferBytes: number;
    inSeq: number;
    ackTimer: NodeJS.Timeout | null;
    detachTimer: NodeJS.Timeout | null;
    destroyed: boolean;
    // The page said goodbye; the session only waits out SESSION_BYE_GRACE_MS.
    closing: boolean;
    // When its socket went away (null while attached); prune evicts the oldest.
    detachedAt: number | null;
    // What this browser holds for big-frame deltas (see frame-delta.ts).
    deltaPeer: DeltaPeer;
    // The page reassembles chunked frames (see sendRaw).
    acceptsChunks: boolean;
  };
  // A detached session is a backgrounded tab or a suspended phone app; keeping
  // it lets that view come back instantly instead of rebooting. Each device
  // keeps at most one (see createSession), so a long TTL stays cheap.
  const SESSION_DETACHED_TTL_MS = 4 * 60 * 60 * 1000;
  const SESSION_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
  const MAX_DETACHED_SESSIONS = 6;
  // After a tab says goodbye, give its window time to flush queued requests
  // (a turn sent right before closing) before tearing it down.
  const SESSION_BYE_GRACE_MS = 30 * 1000;
  const frameDeltas = new FrameDeltaServer({
    disabled: Boolean(process.env.CODEX_WEB_NO_FRAME_DELTA),
    debug: Boolean(process.env.CODEX_WEB_DEBUG_DELTA),
  });

  const sessions = new Map<string, RendererSession>();
  const sessionsByWebContents = new Map<number, RendererSession>();

  // Big frames go out as ~64 KB text chunks ("\u0001<id> <i> <n>\n<part>"):
  // a multi-MB message takes seconds on a slow link, and without visible
  // progress the page's heartbeat took the busy socket for a dead one,
  // reconnected, got the same frame replayed and never finished loading.
  const CHUNK_CHARS = Number(process.env.CODEX_WEB_CHUNK_CHARS) || 64 * 1024;
  let chunkCounter = 0;
  const sendRaw = (session: RendererSession, frame: string): void => {
    const socket = session.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (!session.acceptsChunks || frame.length <= 2 * CHUNK_CHARS) {
      socket.send(frame);
      return;
    }
    const parts: string[] = [];
    for (let start = 0; start < frame.length; ) {
      let end = Math.min(frame.length, start + CHUNK_CHARS);
      const last = frame.charCodeAt(end - 1);
      if (end < frame.length && last >= 0xd800 && last <= 0xdbff) end -= 1; // keep surrogate pairs whole
      parts.push(frame.slice(start, end));
      start = end;
    }
    const id = (chunkCounter += 1).toString(36);
    parts.forEach((part, index) => socket.send(`\u0001${id} ${index} ${parts.length}\n${part}`));
  };
  const sendToSession = (session: RendererSession, message: unknown): void => {
    if (session.destroyed) return;
    const seq = ++session.outSeq;
    const frame = frameDeltas.encode(session.deltaPeer, seq, message);
    session.outBuffer.push({ seq, frame });
    session.outBufferBytes += frame.length;
    if (session.outBufferBytes > SESSION_MAX_BUFFER_BYTES) {
      destroySession(session, "replay buffer full");
      return;
    }
    sendRaw(session, frame);
  };
  const trimOutBuffer = (session: RendererSession, ack: number): void => {
    let drop = 0;
    while (drop < session.outBuffer.length && session.outBuffer[drop]!.seq <= ack) {
      session.outBufferBytes -= session.outBuffer[drop]!.frame.length;
      drop += 1;
    }
    if (drop > 0) session.outBuffer.splice(0, drop);
  };
  const scheduleAck = (session: RendererSession): void => {
    if (session.ackTimer) return;
    session.ackTimer = setTimeout(() => {
      session.ackTimer = null;
      sendRaw(session, JSON.stringify({ ack: session.inSeq }));
    }, 250);
  };
  function destroySession(session: RendererSession, reason = "ended"): void {
    if (session.destroyed) return;
    session.destroyed = true;
    sessions.delete(session.id);
    console.log(`[ipc-bridge] session ${session.id.slice(0, 8)} destroyed (${reason}); ${sessions.size} left`);
    if (session.detachTimer) clearTimeout(session.detachTimer);
    if (session.ackTimer) clearTimeout(session.ackTimer);
    for (const port of session.messagePorts.values()) port.disconnect();
    session.messagePorts.clear();
    if (session.window) {
      sessionsByWebContents.delete(session.window.webContents.id);
      session.window.destroy();
    }
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.close(4410, "Session ended");
    }
  }

  // Stale-while-revalidate cache for the app-server reads every new app view
  // makes during startup. A cached answer is returned immediately (these calls
  // queue behind startup work and took up to 1.3 s each); the real request is
  // still sent in the background and refreshes the cache for the next load.
  // Anything that looks like a write drops that host's entries.
  const CACHEABLE_APP_SERVER_READS = new Set([
    "config/read",
    "configRequirements/read",
    "experimentalFeature/list",
    "model/list",
    "collaborationMode/list",
    "permissionProfile/list",
    "hooks/list",
    "plugin/installed",
    "plugin/read",
    "app/installed",
    "app/read",
    "mcpServerStatus/list",
  ]);
  const APP_SERVER_WRITE_PATTERN =
    /(write|set|update|install|uninstall|enable|disable|add|remove|delete|login|logout|reload|restart|toggle|save|reset)/i;
  const REFRESH_PREFIX = "codex-web-refresh:";
  const appServerCacheDisabled = Boolean(process.env.CODEX_WEB_NO_APP_SERVER_CACHE);
  const appServerCache = new Map<string, { result: unknown; at: number }>();
  const pendingCacheFills = new Map<string, string>();
  type McpRequestEnvelope = {
    type?: string;
    hostId?: string;
    request?: { id?: string; method?: string; params?: unknown };
  };
  const cacheKey = (hostId: string, method: string, params: unknown) =>
    `${hostId}\u0000${method}\u0000${JSON.stringify(params ?? null)}`;
  const invalidateHost = (hostId: string) => {
    for (const key of appServerCache.keys()) {
      if (key.startsWith(`${hostId}\u0000`)) appServerCache.delete(key);
    }
  };
  // Returns true when the reply was served from cache.
  const serveFromAppServerCache = (
    session: RendererSession,
    envelope: McpRequestEnvelope,
    forward: (envelope: McpRequestEnvelope) => void,
  ): boolean => {
    const hostId = envelope.hostId;
    const method = envelope.request?.method;
    const id = envelope.request?.id;
    if (!hostId || !method || !id || appServerCacheDisabled) return false;
    if (!CACHEABLE_APP_SERVER_READS.has(method)) {
      if (APP_SERVER_WRITE_PATTERN.test(method)) invalidateHost(hostId);
      return false;
    }
    const key = cacheKey(hostId, method, envelope.request?.params);
    const cached = appServerCache.get(key);
    if (!cached) {
      pendingCacheFills.set(id, key);
      if (process.env.CODEX_WEB_DEBUG_CACHE) console.log("[cache] miss", method);
      return false;
    }
    if (process.env.CODEX_WEB_DEBUG_CACHE) console.log("[cache] hit", method);
    // Answer after the invoke result the caller sends next: the renderer only
    // registers the request once its invoke resolves.
    queueMicrotask(() =>
      sendToSession(session, {
        type: "ipc-main-event",
        channel: "codex_desktop:message-for-view",
        args: [{ type: "mcp-response", hostId, message: { id, result: cached.result } }],
      }),
    );
    if (Date.now() - cached.at > 5_000) {
      const refreshId = `${REFRESH_PREFIX}${randomUUID()}`;
      pendingCacheFills.set(refreshId, key);
      forward({ ...envelope, request: { ...envelope.request, id: refreshId } });
    }
    return true;
  };
  // Returns false when the message only answered a background refresh.
  const observeAppServerResponse = (message: MainToRendererMessage): boolean => {
    const event = message as { type?: string; channel?: string; args?: unknown[] };
    if (event.type !== "ipc-main-event" || event.channel !== "codex_desktop:message-for-view") return true;
    const payload = event.args?.[0] as
      | { type?: string; message?: { id?: string; result?: unknown; error?: unknown } }
      | undefined;
    if (payload?.type !== "mcp-response") return true;
    const id = payload.message?.id;
    if (typeof id !== "string") return true;
    const key = pendingCacheFills.get(id);
    if (key != null) {
      pendingCacheFills.delete(id);
      if (payload.message && "result" in payload.message && payload.message.error == null) {
        appServerCache.set(key, { result: payload.message.result, at: Date.now() });
        if (process.env.CODEX_WEB_DEBUG_CACHE) console.log("[cache] fill", key.split("\u0000")[1]);
      }
    }
    return !id.startsWith(REFRESH_PREFIX);
  };

  bridgeState.sendToRenderer = (webContentsId, message): void => {
    if (!observeAppServerResponse(message)) return;
    const session = sessionsByWebContents.get(webContentsId);
    if (session) sendToSession(session, message);
  };

  // Secondary windows the app opens without a tab of its own (the realtime
  // voice overlay runs WebRTC + mic capture there). Browser tabs host them as
  // hidden iframes that attach to the existing window over their own session.
  const hostedWindowRoutes = new Set(["/avatar-overlay"]);
  const hostedWindows = new Map<number, string>();
  const attachedWindowIds = new Set<number>();
  const primarySessions = (): RendererSession[] =>
    [...sessions.values()].filter((session) => session.hostedWindowId == null);
  const announceHostedWindow = (session: RendererSession, windowId: number, path: string) =>
    sendToSession(session, { type: "codex-web-open-window", windowId, path });
  const hostedSessionFor = (windowId: number): RendererSession | undefined =>
    [...sessions.values()].find((session) => session.hostedWindowId === windowId && !session.destroyed);
  // Frees a hosted window from an iframe session whose socket is gone (its tab
  // was closed or its app killed without saying goodbye), keeping the window
  // itself alive so another tab can host it.
  const releaseStaleHostedWindow = (windowId: number): boolean => {
    const owner = hostedSessionFor(windowId);
    if (owner?.socket?.readyState === WebSocket.OPEN) return false;
    if (owner) {
      owner.destroyed = true;
      sessions.delete(owner.id);
      if (owner.detachTimer) clearTimeout(owner.detachTimer);
      if (owner.ackTimer) clearTimeout(owner.ackTimer);
      for (const port of owner.messagePorts.values()) port.disconnect();
      owner.messagePorts.clear();
      if (owner.window && sessionsByWebContents.get(owner.window.webContents.id) === owner) {
        sessionsByWebContents.delete(owner.window.webContents.id);
      }
      console.log(`[ipc-bridge] released window ${windowId} from stale session ${owner.id.slice(0, 8)}`);
    }
    attachedWindowIds.delete(windowId);
    return true;
  };
  bridgeState.onWindowLoadURL = (window, url) => {
    let route: string | null = null;
    try {
      route = new URL(url).searchParams.get("initialRoute");
    } catch {}
    if (route == null || !hostedWindowRoutes.has(route)) return;
    const path = `/?${new URLSearchParams({ initialRoute: route, codexWebWindow: String(window.id) })}`;
    hostedWindows.set(window.id, path);
    // One host is enough; prefer the most recently connected live tab.
    const live = primarySessions().filter((session) => session.socket?.readyState === WebSocket.OPEN);
    const host = live.at(-1) ?? primarySessions().at(-1);
    if (host) announceHostedWindow(host, window.id, path);
  };
  bridgeState.onWindowDestroyed = (window) => {
    if (!hostedWindows.delete(window.id)) return;
    attachedWindowIds.delete(window.id);
    for (const session of primarySessions()) {
      sendToSession(session, { type: "codex-web-close-window", windowId: window.id });
    }
  };

  const dispatchPostMessage = (
    channel: string,
    message: unknown,
    ports: WebSocketMessagePort[],
    windowId: number,
  ): void => {
    const handler = bridgeState.handleRendererPostMessage;
    if (handler) {
      handler(channel, message, ports, windowId);
      return;
    }

    console.error(
      `[ipc-bridge] no ipcMain postMessage handler for channel ${channel}`,
    );
    for (const port of ports) {
      port.close();
    }
  };

  // One backend view per device: a device that boots a fresh page can never
  // resume its older detached views (their page state is gone), so drop them,
  // and cap detached views overall.
  const pruneDetachedSessions = (clientId: string | null, deviceId: string): void => {
    const detached = primarySessions().filter((session) => session.socket == null && !session.closing);
    for (const session of detached) {
      if (clientId != null && session.clientId === clientId && session.deviceId === deviceId) {
        destroySession(session, "replaced by a new page on the same device");
      }
    }
    const remaining = primarySessions()
      .filter((session) => session.socket == null && !session.closing)
      .sort((a, b) => (a.detachedAt ?? 0) - (b.detachedAt ?? 0));
    for (const session of remaining.slice(0, Math.max(0, remaining.length - MAX_DETACHED_SESSIONS))) {
      destroySession(session, "too many detached sessions");
    }
  };

  const createSession = (hostedWindowId: number | null, clientId: string | null, deviceId: string): RendererSession => {
    const createdAt = Date.now();
    if (hostedWindowId == null) pruneDetachedSessions(clientId, deviceId);
    const session: RendererSession = {
      id: randomUUID(),
      deviceId,
      clientId,
      hostedWindowId,
      socket: null,
      window: undefined,
      ready: Promise.resolve(undefined),
      messagePorts: new Map(),
      outSeq: 0,
      outBuffer: [],
      outBufferBytes: 0,
      inSeq: 0,
      ackTimer: null,
      detachTimer: null,
      destroyed: false,
      closing: false,
      detachedAt: null,
      deltaPeer: newDeltaPeer(),
      acceptsChunks: false,
    };
    const attachTarget =
      hostedWindowId == null ? null : bridgeState.getWindowById?.(hostedWindowId) ?? null;
    // Each tab is a real registered app view, with its own IPC client and ownership.
    session.ready = (
      attachTarget != null
        ? Promise.resolve(() => {
            attachedWindowIds.add(attachTarget.id);
            return Promise.resolve(attachTarget);
          })
        : rendererWindowFactory
    )
      .then(async (createWindow) => {
        if (session.destroyed) return undefined;
        const window = await createWindow();
        if (session.destroyed) {
          window.destroy();
          return undefined;
        }
        session.window = window;
        sessionsByWebContents.set(window.webContents.id, session);
        console.log(`[ipc-bridge] session ${session.id.slice(0, 8)} window ready in ${Date.now() - createdAt} ms`);
        return window;
      })
      .catch((error) => {
        console.error("[ipc-bridge] failed to create renderer window", error);
        destroySession(session, "window creation failed");
        return undefined;
      });
    sessions.set(session.id, session);
    return session;
  };

  const handleRendererMessage = async (
    session: RendererSession,
    message: RendererToMainMessage,
  ): Promise<void> => {
    const window = await session.ready;
    if (!window || session.destroyed) return;
    const reply = (payload: MainToRendererMessage) => sendToSession(session, payload);

    if (message.type === "ipc-renderer-send") {
      bridgeState.handleRendererSend?.(message.channel, message.args, window.id);
      return;
    }

    if (message.type === "ipc-renderer-post-message") {
      if (new Set(message.portIds).size !== message.portIds.length) {
        console.error("[ipc-bridge] duplicate transferred MessagePort id");
        return;
      }

      const ports = message.portIds.map((portId) => {
        const existingPort = session.messagePorts.get(portId);
        if (existingPort) {
          existingPort.disconnect();
        }
        const port = new WebSocketMessagePort(
          portId,
          (portMessage) => sendToSession(session, portMessage),
          () => session.messagePorts.delete(portId),
        );
        session.messagePorts.set(portId, port);
        return port;
      });

      dispatchPostMessage(message.channel, message.message, ports, window.id);
      return;
    }

    if (message.type === "message-port-message") {
      session.messagePorts.get(message.portId)?.receiveMessage(message.data);
      return;
    }

    if (message.type === "message-port-close") {
      session.messagePorts.get(message.portId)?.disconnect();
      return;
    }

    if (message.type === "workspace-directory-entries-request") {
      const { requestId } = message;
      getWorkspaceDirectoryEntries(message)
        .then((result) =>
          reply({ type: "workspace-directory-entries-result", requestId, ok: true, result }),
        )
        .catch((error) =>
          reply({
            type: "workspace-directory-entries-result",
            requestId,
            ok: false,
            errorMessage: errorMessage(error),
          }),
        );
      return;
    }

    if (message.type === "ipc-renderer-invoke") {
      const { channel, requestId, args } = message;
      if (channel === "codex_desktop:message-from-view") {
        const envelope = args[0] as McpRequestEnvelope | undefined;
        if (
          envelope?.type === "mcp-request" &&
          serveFromAppServerCache(session, envelope, (refresh) => {
            void bridgeState.handleRendererInvoke?.(channel, [refresh], window.id)?.catch?.(() => {});
          })
        ) {
          reply({ type: "ipc-renderer-invoke-result", requestId, ok: true, result: undefined });
          return;
        }
      }
      Promise.resolve(
        bridgeState.handleRendererInvoke?.(channel, args, window.id) ??
          Promise.reject(
            new Error(`[ipc-bridge] no ipcMain.handle for channel ${channel}`),
          ),
      )
        .then((result) =>
          reply({ type: "ipc-renderer-invoke-result", requestId, ok: true, result }),
        )
        .catch((error) =>
          reply({
            type: "ipc-renderer-invoke-result",
            requestId,
            ok: false,
            errorMessage: errorMessage(error),
          }),
        );
    }
  };

  // A revoked or expired device loses its sockets, sessions and open HTTP
  // connections within a second (the store re-reads devices.json when it
  // changes). Running turns are unaffected.
  let storeProblem = deviceStore.error;
  setInterval(() => {
    deviceStore.refresh();
    if (deviceStore.error !== storeProblem) {
      storeProblem = deviceStore.error;
      if (storeProblem) console.error(`[device-auth] ${storeProblem}; every request is refused until it is fixed`);
    }
    for (const session of [...sessions.values()]) {
      if (deviceStore.isActive(session.deviceId)) continue;
      const socket = session.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.close(4401, "Device revoked");
        // The close code lets the page show the pairing screen; do not wait
        // on the client to finish the closing handshake.
        setTimeout(() => socket.terminate(), 1000).unref();
      }
      destroySession(session, "device revoked");
    }
    gate.dropRevokedConnections();
  }, 1000).unref();

  websocketServer.on("connection", (socket, request: { url?: string }) => {
    const device = upgradeDevices.get(request);
    if (!device) {
      socket.close(4401, "Unauthorized");
      return;
    }
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    const resumeId = params.get("session");
    const clientId = params.get("client")?.slice(0, 64) || null;
    // Only pages that understand big-frame deltas ask for them.
    const wantsPlainFrames = params.get("fd") !== "1";
    const attachWindowId = Number(params.get("attachWindow"));
    const wantsHostedWindow = Number.isInteger(attachWindowId) && attachWindowId > 0;

    let session: RendererSession;
    let resumed = false;
    if (resumeId != null) {
      const existing = sessions.get(resumeId);
      if (!existing || existing.destroyed || existing.deviceId !== device.id) {
        // The tab must rebuild its app view; tell it so it reloads.
        socket.send(JSON.stringify({ hello: { resumeFailed: true } }));
        socket.close(4410, "Session expired");
        return;
      }
      session = existing;
      resumed = true;
      if (session.socket && session.socket !== socket) {
        session.socket.removeAllListeners("close");
        session.socket.close(4409, "Superseded by a newer connection");
      }
      if (session.detachTimer) {
        clearTimeout(session.detachTimer);
        session.detachTimer = null;
      }
      // Back after all (e.g. restored from the back/forward cache after pagehide).
      session.closing = false;
      session.detachedAt = null;
      trimOutBuffer(session, Number(params.get("ack")) || 0);
    } else if (wantsHostedWindow) {
      if (
        !hostedWindows.has(attachWindowId) ||
        !bridgeState.getWindowById?.(attachWindowId) ||
        !releaseStaleHostedWindow(attachWindowId)
      ) {
        // A hosted iframe outlived its window; never let it become a primary tab.
        socket.send(JSON.stringify({ hello: { resumeFailed: true } }));
        socket.close(4404, "Window is gone");
        return;
      }
      session = createSession(attachWindowId, clientId, device.id);
    } else {
      session = createSession(null, clientId, device.id);
    }

    session.socket = socket;
    session.deltaPeer.disabled = wantsPlainFrames;
    session.acceptsChunks = params.get("ck") === "1";
    socket.send(
      JSON.stringify({ hello: { session: session.id, resumed, lastClientSeq: session.inSeq } }),
    );
    for (const { frame } of session.outBuffer) sendRaw(session, frame); // chunked like live frames
    if (!resumed && session.hostedWindowId == null) {
      for (const [windowId, path] of hostedWindows) {
        if (!attachedWindowIds.has(windowId) || releaseStaleHostedWindow(windowId)) {
          announceHostedWindow(session, windowId, path);
        }
      }
    }

    socket.on("close", () => {
      if (session.socket !== socket) return;
      session.socket = null;
      session.detachedAt = Date.now();
      if (session.destroyed || session.closing) return;
      session.detachTimer = setTimeout(() => destroySession(session, "detached too long"), SESSION_DETACHED_TTL_MS);
    });

    // After a failed upload decode we close the socket, but ws still delivers
    // frames already in flight; handling those would skip the failed seq.
    let rejected = false;
    socket.on("message", (rawData) => {
      if (rejected) return;
      let frame: {
        s?: number;
        m?: RendererToMainMessage;
        u?: unknown;
        ack?: number;
        ping?: unknown;
        bye?: unknown;
        bases?: unknown;
        at?: number;
      };
      try {
        frame = JSON.parse(String(rawData));
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }
      if (typeof frame.ack === "number") {
        trimOutBuffer(session, frame.ack);
        return;
      }
      if (frame.ping !== undefined) {
        sendRaw(session, JSON.stringify({ pong: frame.ping }));
        return;
      }
      if (frame.bases !== undefined) {
        const accepted = frameDeltas.acceptDeclared(session.deltaPeer, frame.bases, Number(frame.at) || 0);
        sendRaw(session, JSON.stringify({ basesOk: accepted }));
        return;
      }
      if (frame.bye !== undefined) {
        // Tab is unloading for real (closed or reloaded): its page state is
        // gone, but let the window flush what it queued before freeing it.
        // Running work lives in the engine and is unaffected either way.
        if (session.detachTimer) clearTimeout(session.detachTimer);
        session.closing = true;
        session.detachTimer = setTimeout(() => destroySession(session, "page closed"), SESSION_BYE_GRACE_MS);
        return;
      }
      if (typeof frame.s !== "number") return;
      if (frame.s <= session.inSeq) return; // replayed after a resume
      if (frame.u !== undefined) {
        try {
          frame.m = frameDeltas.decodeUpload(session.deltaPeer, frame.u) as RendererToMainMessage;
        } catch (error) {
          // Make the tab reconnect; it replays unacknowledged frames whole.
          console.error(`[frame-delta] could not decode upload ${frame.s}`, error);
          rejected = true;
          socket.close(4000, "Resend frames in full");
          return;
        }
      }
      if (frame.m == null) return;
      session.inSeq = frame.s;
      scheduleAck(session);
      void handleRendererMessage(session, frame.m);
    });
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  const module = require(matches[0]!);
  // Since 26.924 the bundled bootstrap also calls runMainAppStartup once main
  // loads; a second run throws "shouldSpawnInsideWsl already set" and can kill
  // the server. Both callers read the export late, so make it run once.
  const runMainAppStartup = module.runMainAppStartup;
  let startup: Promise<unknown> | undefined;
  module.runMainAppStartup = () => (startup ??= runMainAppStartup());
  module.runMainAppStartup();
  return { gate };
}

// One backend per machine: a second server would start a second app-server,
// SSH link and set of app windows on the same ~/.codex. Every viewer (tabs,
// the phone app) attaches to the one that is running.
async function acquireSingleInstanceLock(options: ServerOptions): Promise<void> {
  const lockDir = path.join(os.homedir(), ".codex-anywhere");
  const lockPath = path.join(lockDir, "server.lock");
  await fs.mkdir(lockDir, { recursive: true });
  // A live server with that pid that started no later than the lock was
  // written (a reused pid after a reboot started later).
  const isOurServer = (pid: number, lockedAt: number): boolean => {
    try {
      process.kill(pid, 0);
      const [elapsed = "", ...command] = execFileSync("/bin/ps", ["-o", "etime=,command=", "-p", String(pid)], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
      if (!/launchd-entry\.cjs|src\/server\/main\.js/.test(command.join(" "))) return false;
      const [days, clock = ""] = elapsed.includes("-") ? elapsed.split("-") : ["0", elapsed];
      const seconds = clock.split(":").map(Number).reduce((total, part) => total * 60 + part, 0) + Number(days) * 86400;
      return !Number.isFinite(lockedAt) || Date.now() - seconds * 1000 <= lockedAt + 5_000;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, port: options.port, startedAt: new Date().toISOString() }));
      await handle.close();
      process.once("exit", () => {
        try {
          const holder = JSON.parse(require("node:fs").readFileSync(lockPath, "utf8")) as { pid?: number };
          if (holder.pid === process.pid) require("node:fs").rmSync(lockPath, { force: true });
        } catch {}
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: { pid?: number; port?: number; startedAt?: string } = {};
    try {
      holder = JSON.parse(await fs.readFile(lockPath, "utf8"));
    } catch {} // unreadable or half-written: stale
    if (
      typeof holder.pid === "number" &&
      holder.pid !== process.pid &&
      isOurServer(holder.pid, Date.parse(holder.startedAt ?? ""))
    ) {
      console.error(
        `codex-anywhere is already running (pid ${holder.pid}, port ${holder.port}); not starting a second backend. ` +
          "Restart it with scripts/serve.",
      );
      process.exit(1);
    }
    await fs.rm(lockPath, { force: true });
  }
  throw new Error(`could not acquire ${lockPath}`);
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await acquireSingleInstanceLock(options);
  const { gate } = await startIpcBridgeServer(options);
  // Optional: a failure here (port taken, shell not mirrored) only disables
  // MCP App pages, never the app itself.
  await startMcpSandboxServer(options, gate).catch((error) => {
    console.error("[mcp-sandbox] not started; MCP App pages will not render:", error);
  });
}

// MCP App pages (plugin sidebar pages, thread panels, inline widgets) render in
// OpenAI's sandbox shell. The desktop app loads it from
// codex-sandbox://*.web-sandbox.oaiusercontent.com, i.e. from OpenAI's CDN.
// We serve our own copy (scripts/mirror_mcp_sandbox.mjs) on the next port: a
// separate origin from the app, so a page can't reach the app's DOM, and no
// request leaves this machine when a page renders. The page HTML itself comes
// from the local MCP server through app-server and a MessagePort.
//
// Same hostname, so browsers send the device cookie here too and treat both
// ports as one site. The app's gate refuses anything from this origin except
// plain page loads (see DeviceGate.handleRequest), and this server answers
// only paired devices, and only as an iframe of the app
// (DeviceGate.handleSandboxRequest).
async function startMcpSandboxServer(options: ServerOptions, gate: DeviceGate): Promise<void> {
  // The browser shim always puts the sandbox on the app's port + 1.
  if (process.env.CODEX_ANYWHERE_SANDBOX === "off") return;
  const sandboxPort = options.port + 1;
  const root = path.resolve(__dirname, "../../scratch/mcp-sandbox");
  if (!(await fs.stat(path.join(root, "mcp-app.html")).catch(() => null))) {
    console.warn(`[mcp-sandbox] ${root} is missing; run scripts/mirror_mcp_sandbox.mjs. MCP App pages will not render.`);
    return;
  }
  // Only the app itself may frame the shell: same scheme and host, port - 1.
  // The shell posts its MessagePorts to window.parent with targetOrigin "*",
  // so a wider frame-ancestors would hand them to any page that frames it.
  const frameAncestors = (request: http.IncomingMessage): string => {
    if (process.env.CODEX_ANYWHERE_SANDBOX_FRAME_ANCESTORS) return process.env.CODEX_ANYWHERE_SANDBOX_FRAME_ANCESTORS;
    const forwarded = request.headers["x-forwarded-host"];
    const host = String((Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || request.headers.host || "");
    const match = host.match(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d+)$/);
    if (!match) return "'none'";
    const appPort = Number(match[2]) - 1;
    return `${gate.requestScheme(request)}//${match[1]}:${appPort}`;
  };
  const sandbox = Fastify({
    logger: false,
    serverFactory: (handler) =>
      http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
        if (gate.handleSandboxRequest(request, response)) return;
        handler(request, response);
      }),
  });
  sandbox.addHook("onSend", async (request, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      `frame-ancestors ${frameAncestors(request.raw)}; frame-src 'self' https: data: blob:; sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms`,
    );
    reply.header("Permissions-Policy", "camera=(self), microphone=(self), storage-access=()");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });
  await sandbox.register(fastifyStatic, {
    root,
    prefix: "/",
    index: false,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      // private: each response depends on the device cookie.
      res.setHeader(
        "Cache-Control",
        filePath.includes(`${path.sep}assets${path.sep}`) ? "private, max-age=31536000, immutable" : "no-cache",
      );
    },
  });
  // The renderer opens `/?app=skybridge&...#initId=...`; the desktop app maps
  // that to /mcp-app.html the same way.
  sandbox.get("/", async (_request, reply) => reply.sendFile("mcp-app.html"));
  await sandbox.listen({ host: options.host, port: sandboxPort });
  console.log(`[mcp-sandbox] serving MCP App sandbox shell at http://${options.host}:${sandboxPort} (paired devices, framed by the app only)`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error("codex-anywhere failed to start:", error);
  process.exit(1);
});
