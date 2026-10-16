import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
type StubFunction = (...args: unknown[]) => unknown;
type StubListener = (...args: unknown[]) => void;
type StubMessagePort = {
  close: () => void;
  on: (event: string, listener: StubListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};
type StubWebContents = {
  id: number;
  mainFrame: {
    url: string;
  };
  getURL: () => string;
  isDestroyed: () => boolean;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  removeListener: (event: string, listener: StubListener) => unknown;
  send: (channel: string, ...args: unknown[]) => void;
};
type IpcMainEvent = {
  returnValue: unknown;
  processId: number;
  frameId: number;
  sender: StubWebContents;
  senderFrame: {
    url: string;
  };
  ports: StubMessagePort[];
  reply: (channel: string, ...args: unknown[]) => void;
};

type IpcMainBridgeState = {
  sendToRenderer?: (
    webContentsId: number,
    message: {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    },
  ) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: StubMessagePort[],
    windowId: number,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => void;
  // Secondary app windows (e.g. the realtime voice overlay) have no browser
  // tab of their own; main.ts hosts them as hidden iframes in an open tab.
  onWindowLoadURL?: (window: BrowserWindow, url: string) => void;
  onWindowDestroyed?: (window: BrowserWindow) => void;
  getWindowById?: (id: number) => BrowserWindow | null;
};

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

// Per-call tracing formats large objects synchronously on the main thread
// (~0.5 MB per page load), so it is opt-in.
const debugStubCalls = Boolean(process.env.CODEX_WEB_DEBUG);

function log(method: string, args: unknown[]): void {
  if (debugStubCalls) console.log(`[electron-main-stub] ${method}`, args);
}

function createDeepStub(pathLabel: string): StubFunction {
  const fn: StubFunction = (...args: unknown[]) => {
    log(`${pathLabel}()`, args);
    return undefined;
  };

  return new Proxy(fn, {
    apply(_target, _thisArg, argArray) {
      log(`${pathLabel}()`, argArray);
      return undefined;
    },
    construct(_target, argArray) {
      log(`new ${pathLabel}()`, argArray);
      return {};
    },
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }

      if (prop === Symbol.toPrimitive) {
        return () => pathLabel;
      }

      // Callers may do `Reflect.apply(stub.fn.bind(stub), ...)`; keep the real
      // Function.prototype helpers so the bound call reaches the apply trap.
      if (prop === "bind" || prop === "call" || prop === "apply") {
        return Reflect.get(Function.prototype, prop);
      }

      return createDeepStub(`${pathLabel}.${String(prop)}`);
    },
  });
}

function createEmitterStub(label: string): {
  addListener: (event: string, listener: StubListener) => unknown;
  emit: (event: string, ...args: unknown[]) => boolean;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  removeListener: (event: string, listener: StubListener) => unknown;
} {
  const listeners = new Map<string, Set<StubListener>>();

  const api = {
    on(event: string, listener: StubListener): unknown {
      log(`${label}.on`, [event, listener]);
      const eventListeners = listeners.get(event) ?? new Set<StubListener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return api;
    },
    once(event: string, listener: StubListener): unknown {
      log(`${label}.once`, [event, listener]);
      const wrapped: StubListener = (...args: unknown[]) => {
        api.removeListener(event, wrapped);
        listener(...args);
      };
      return api.on(event, wrapped);
    },
    addListener(event: string, listener: StubListener): unknown {
      log(`${label}.addListener`, [event, listener]);
      return api.on(event, listener);
    },
    removeListener(event: string, listener: StubListener): unknown {
      log(`${label}.removeListener`, [event, listener]);
      listeners.get(event)?.delete(listener);
      return api;
    },
    off(event: string, listener: StubListener): unknown {
      log(`${label}.off`, [event, listener]);
      return api.removeListener(event, listener);
    },
    emit(event: string, ...args: unknown[]): boolean {
      log(`${label}.emit`, [event, ...args]);
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
      return true;
    },
  };

  return api;
}

function createMessagePortStub(label: string): {
  on: (event: string, listener: StubListener) => unknown;
  postMessage: (...args: unknown[]) => void;
  start: () => void;
} {
  const emitter = createEmitterStub(label);
  return {
    on: emitter.on,
    postMessage(...args: unknown[]): void {
      log(`${label}.postMessage`, args);
    },
    start(): void {
      log(`${label}.start`, []);
    },
  };
}

function createIpcMainEvent(
  windowId: number,
  ports: StubMessagePort[] = [],
): IpcMainEvent {
  const window = BrowserWindow.fromId(windowId);
  if (!window || window.isDestroyed()) {
    throw new Error(
      `[electron-main-stub] Renderer window ${windowId} is closed`,
    );
  }
  const sender = window.webContents as unknown as StubWebContents;
  return {
    returnValue: undefined,
    processId: windowId,
    frameId: 1,
    sender,
    senderFrame: sender.mainFrame,
    ports,
    reply: (channel: string, ...args: unknown[]): void => {
      sender.send(channel, ...args);
    },
  };
}

function createIpcMainStub(): {
  handle: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ) => void;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  removeHandler: (channel: string) => void;
} {
  const emitter = createEmitterStub("ipcMain");
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const bridgeState = getIpcMainBridgeState();

  const pendingPostMessages = new Map<
    string,
    Array<{ message: unknown; ports: StubMessagePort[]; windowId: number }>
  >();
  const registeredPostMessageChannels = new Set<string>();

  bridgeState.handleRendererPostMessage = (
    channel: string,
    message: unknown,
    ports: StubMessagePort[],
    windowId: number,
  ): void => {
    if (registeredPostMessageChannels.has(channel)) {
      emitter.emit(channel, createIpcMainEvent(windowId, ports), message);
      return;
    }
    const pending = pendingPostMessages.get(channel) ?? [];
    pending.push({ message, ports, windowId });
    pendingPostMessages.set(channel, pending);
  };

  bridgeState.handleRendererInvoke = async (
    channel: string,
    args: unknown[],
    windowId: number,
  ): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`[electron-main-stub] No ipcMain.handle for ${channel}`);
    }
    const event = createIpcMainEvent(windowId);
    return await Promise.resolve(handler(event, ...args));
  };

  bridgeState.handleRendererSend = (
    channel: string,
    args: unknown[],
    windowId: number,
  ): void => {
    const event = createIpcMainEvent(windowId);
    emitter.emit(channel, event, ...args);
  };

  return {
    on(channel: string, listener: StubListener): unknown {
      const result = emitter.on(channel, listener);
      registeredPostMessageChannels.add(channel);
      const pending = pendingPostMessages.get(channel);
      if (pending) {
        pendingPostMessages.delete(channel);
        for (const { message, ports, windowId } of pending) {
          if (!BrowserWindow.fromId(windowId)) continue;
          emitter.emit(channel, createIpcMainEvent(windowId, ports), message);
        }
      }
      return result;
    },
    off: emitter.off,
    handle(
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ): void {
      log("ipcMain.handle", [channel, handler]);
      handlers.set(channel, handler);
    },
    removeHandler(channel: string): void {
      log("ipcMain.removeHandler", [channel]);
      handlers.delete(channel);
    },
  };
}

let appReady = false;
const commandLineSwitches = new Map<string, string>();
const commandLineArguments: string[] = [];

const appBase = {
  ...createEmitterStub("app"),
  name: "Codex",
  isPackaged: false,
  getName(): string {
    log("app.getName", []);
    return "Codex";
  },
  getVersion(): string {
    return globalThis.__CODEX_SHIM_VALUES__.version;
  },
  getLocale(): string {
    log("app.getLocale", []);
    return "en-US";
  },
  getSystemLocale(): string {
    log("app.getSystemLocale", []);
    return "en-US";
  },
  getPreferredSystemLanguages(): string[] {
    log("app.getPreferredSystemLanguages", []);
    return ["en-US"];
  },
  getPath(name: string): string {
    log("app.getPath", [name]);
    return process.cwd();
  },
  getAppMetrics(): unknown[] {
    log("app.getAppMetrics", []);
    return [];
  },
  getAppPath(): string {
    log("app.getAppPath", []);
    return process.cwd();
  },
  async getGPUInfo(infoLevel: string): Promise<{ gpuDevice: unknown[] }> {
    log("app.getGPUInfo", [infoLevel]);
    return { gpuDevice: [] };
  },
  setName(name: string): void {
    log("app.setName", [name]);
  },
  setPath(name: string, value: string): void {
    log("app.setPath", [name, value]);
  },
  setAppUserModelId(value: string): void {
    log("app.setAppUserModelId", [value]);
  },
  requestSingleInstanceLock(): boolean {
    log("app.requestSingleInstanceLock", []);
    return true;
  },
  isReady(): boolean {
    log("app.isReady", []);
    return appReady;
  },
  whenReady(): Promise<void> {
    log("app.whenReady", []);
    appReady = true;
    return Promise.resolve();
  },
  commandLine: {
    appendSwitch(name: string, value?: string): void {
      log("app.commandLine.appendSwitch", [name, value]);
      commandLineSwitches.set(name, value ?? "");
    },
    appendArgument(value: string): void {
      log("app.commandLine.appendArgument", [value]);
      commandLineArguments.push(value);
    },
    getSwitchValue(name: string): string {
      log("app.commandLine.getSwitchValue", [name]);
      return commandLineSwitches.get(name) ?? "";
    },
    hasSwitch(name: string): boolean {
      log("app.commandLine.hasSwitch", [name]);
      return commandLineSwitches.has(name);
    },
    removeSwitch(name: string): void {
      log("app.commandLine.removeSwitch", [name]);
      commandLineSwitches.delete(name);
    },
  },
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    log("app.on", [event, listener]);
    return app;
  },
  once(event: string, listener: (...args: unknown[]) => void): unknown {
    log("app.once", [event, listener]);
    return app;
  },
  quit(): void {
    log("app.quit", []);
  },
  exit(code?: number): void {
    log("app.exit", [code]);
  },
};

const app = new Proxy(appBase as Record<string, unknown>, {
  get(target, prop) {
    if (prop in target) {
      return target[prop as keyof typeof target];
    }

    return createDeepStub(`app.${String(prop)}`);
  },
}) as typeof appBase;

class BrowserWindow {
  static isAlwaysOnTopSupported(): boolean {
    return false;
  }

  static isInputShapeSupported(): boolean {
    return false;
  }

  static isSystemBackdropSupported(): boolean {
    return false;
  }

  static fromId(id: number): BrowserWindow | null {
    return (
      BrowserWindow.getAllWindows().find((window) => window.id === id) ?? null
    );
  }

  static nextId = 1;
  static allWindows: BrowserWindow[] = [];
  static focusedWindow: BrowserWindow | null = null;
  id: number;
  private destroyed = false;
  private visible = true;
  private title = "Codex";
  private bounds = { x: 0, y: 0, width: 1280, height: 820 };
  webContents: Record<string, unknown>;
  private readonly emitter: ReturnType<typeof createEmitterStub>;

  constructor(...args: unknown[]) {
    log("new BrowserWindow", args);
    this.visible = (args[0] as { show?: boolean } | undefined)?.show !== false;
    this.id = BrowserWindow.nextId++;
    this.emitter = createEmitterStub(`BrowserWindow#${this.id}`);

    const webContentsEmitter = createEmitterStub(
      `BrowserWindow#${this.id}.webContents`,
    );
    this.webContents = new Proxy(
      {
        ...webContentsEmitter,
        id: this.id * 1000 + 1,
        mainFrame: {
          url: "",
        },
        getURL: (): string => {
          log(`BrowserWindow#${this.id}.webContents.getURL`, []);
          return String(
            (this.webContents.mainFrame as { url?: string } | undefined)?.url ??
              "",
          );
        },
        isDestroyed: (): boolean => this.destroyed,
        loadURL: async (url: string): Promise<void> => {
          log(`BrowserWindow#${this.id}.webContents.loadURL`, [url]);
          (this.webContents.mainFrame as { url: string }).url = url;
          getIpcMainBridgeState().onWindowLoadURL?.(this, url);
        },
        loadFile: async (...loadFileArgs: unknown[]): Promise<void> => {
          log(`BrowserWindow#${this.id}.webContents.loadFile`, loadFileArgs);
        },
        openDevTools: (...openDevToolsArgs: unknown[]): void => {
          log(
            `BrowserWindow#${this.id}.webContents.openDevTools`,
            openDevToolsArgs,
          );
        },
        send: (...sendArgs: unknown[]): void => {
          log(`BrowserWindow#${this.id}.webContents.send`, sendArgs);
          if (sendArgs.length === 0 || typeof sendArgs[0] !== "string") {
            return;
          }
          const [channel, ...args] = sendArgs as [string, ...unknown[]];
          getIpcMainBridgeState().sendToRenderer?.(
            this.webContents.id as number,
            {
              type: "ipc-main-event",
              channel,
              args,
            },
          );
        },
      } as Record<string, unknown>,
      {
        get: (target, prop) => {
          // Async Electron APIs can return this proxy; it must not be thenable.
          if (prop === "then") {
            return undefined;
          }
          if (prop in target) {
            return target[prop as keyof typeof target];
          }
          return createDeepStub(
            `BrowserWindow#${this.id}.webContents.${String(prop)}`,
          );
        },
      },
    );

    const window = new Proxy(this, {
      get: (target, prop) => {
        if (prop === "then") {
          return undefined;
        }
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        return createDeepStub(`BrowserWindow#${target.id}.${String(prop)}`);
      },
    });
    BrowserWindow.allWindows.push(window);
    BrowserWindow.focusedWindow = window;
    return window;
  }

  static getAllWindows(): BrowserWindow[] {
    log("BrowserWindow.getAllWindows", []);
    return BrowserWindow.allWindows.filter((window) => !window.destroyed);
  }

  static getFocusedWindow(): BrowserWindow | null {
    log("BrowserWindow.getFocusedWindow", []);
    if (BrowserWindow.focusedWindow && !BrowserWindow.focusedWindow.destroyed) {
      return BrowserWindow.focusedWindow;
    }
    return BrowserWindow.getAllWindows()[0] ?? null;
  }

  static fromWebContents(
    webContents: { id?: unknown } | null | undefined,
  ): BrowserWindow | null {
    log("BrowserWindow.fromWebContents", [webContents]);
    if (!webContents) {
      return null;
    }

    return (
      BrowserWindow.getAllWindows().find(
        (window) =>
          window.webContents === webContents ||
          window.webContents.id === webContents.id,
      ) ?? null
    );
  }

  on(event: string, listener: StubListener): unknown {
    return this.emitter.on(event, listener);
  }

  once(event: string, listener: StubListener): unknown {
    return this.emitter.once(event, listener);
  }

  off(event: string, listener: StubListener): unknown {
    return this.emitter.off(event, listener);
  }

  removeListener(event: string, listener: StubListener): unknown {
    return this.emitter.removeListener(event, listener);
  }

  async loadURL(url: string): Promise<void> {
    log(`BrowserWindow#${this.id}.loadURL`, [url]);
    (this.webContents.mainFrame as { url: string }).url = url;
    getIpcMainBridgeState().onWindowLoadURL?.(this, url);
  }

  close(): void {
    log(`BrowserWindow#${this.id}.close`, []);
    this.emitter.emit("close", {
      preventDefault: () => undefined,
    });
    this.destroy();
  }

  destroy(): void {
    log(`BrowserWindow#${this.id}.destroy`, []);
    if (this.destroyed) return;
    this.destroyed = true;
    (this.webContents.emit as StubFunction)("destroyed");
    BrowserWindow.allWindows = BrowserWindow.allWindows.filter(
      (window) => window !== this,
    );
    if (BrowserWindow.focusedWindow === this) {
      BrowserWindow.focusedWindow = null;
    }
    getIpcMainBridgeState().onWindowDestroyed?.(this);
    this.emitter.emit("closed");
  }

  isDestroyed(): boolean {
    log(`BrowserWindow#${this.id}.isDestroyed`, []);
    return this.destroyed;
  }

  isFocused(): boolean {
    log(`BrowserWindow#${this.id}.isFocused`, []);
    return BrowserWindow.focusedWindow === this && !this.destroyed;
  }

  isVisible(): boolean {
    return this.visible && !this.destroyed;
  }

  removeMenu(): void {
    log(`BrowserWindow#${this.id}.removeMenu`, []);
  }

  getTitle(): string {
    log(`BrowserWindow#${this.id}.getTitle`, []);
    return this.title;
  }

  setTitle(nextTitle: string): void {
    log(`BrowserWindow#${this.id}.setTitle`, [nextTitle]);
    this.title = nextTitle;
  }

  getBounds(): { height: number; width: number; x: number; y: number } {
    log(`BrowserWindow#${this.id}.getBounds`, []);
    return { ...this.bounds };
  }

  setBounds(nextBounds: {
    height?: number;
    width?: number;
    x?: number;
    y?: number;
  }): void {
    log(`BrowserWindow#${this.id}.setBounds`, [nextBounds]);
    this.bounds = {
      x: nextBounds.x ?? this.bounds.x,
      y: nextBounds.y ?? this.bounds.y,
      width: nextBounds.width ?? this.bounds.width,
      height: nextBounds.height ?? this.bounds.height,
    };
  }

  // No frame in the browser, so content bounds are the window bounds. The
  // voice overlay positions itself with these; a missing one returned
  // undefined and broke voice start ("reading 'x'").
  getContentBounds(): { height: number; width: number; x: number; y: number } {
    return this.getBounds();
  }

  setContentBounds(nextBounds: { height?: number; width?: number; x?: number; y?: number }): void {
    this.setBounds(nextBounds);
  }

  getPosition(): [number, number] {
    return [this.bounds.x, this.bounds.y];
  }

  setPosition(x: number, y: number): void {
    this.setBounds({ x, y });
  }

  getSize(): [number, number] {
    return [this.bounds.width, this.bounds.height];
  }

  setSize(width: number, height: number): void {
    this.setBounds({ width, height });
  }

  getContentSize(): [number, number] {
    return this.getSize();
  }

  setContentSize(width: number, height: number): void {
    this.setSize(width, height);
  }

  show(): void {
    log(`BrowserWindow#${this.id}.show`, []);
    this.visible = true;
  }

  hide(): void {
    log(`BrowserWindow#${this.id}.hide`, []);
    this.visible = false;
  }

  focus(): void {
    log(`BrowserWindow#${this.id}.focus`, []);
    BrowserWindow.focusedWindow = this;
    this.emitter.emit("focus");
  }
}

class WebContentsView {
  constructor(...args: unknown[]) {
    log("new WebContentsView", args);
  }
}

class Menu {
  static applicationMenu: Menu | null = null;
  items: MenuItem[] = [];

  constructor(items: MenuItem[] = []) {
    this.items = items;
  }

  static buildFromTemplate(template: unknown[]): Menu {
    log("Menu.buildFromTemplate", [template]);
    const items = template.map((entry) => new MenuItem(entry));
    return new Menu(items);
  }

  static setApplicationMenu(menu: Menu | null): void {
    log("Menu.setApplicationMenu", [menu]);
    Menu.applicationMenu = menu;
  }

  static getApplicationMenu(): Menu | null {
    log("Menu.getApplicationMenu", []);
    return Menu.applicationMenu;
  }

  getMenuItemById(id: string): MenuItem | undefined {
    log("Menu.getMenuItemById", [id]);
    const queue = [...this.items];
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!candidate) {
        continue;
      }
      if (candidate.id === id) {
        return candidate;
      }
      if (candidate.submenu) {
        queue.push(...candidate.submenu.items);
      }
    }
    return undefined;
  }

  append(item: MenuItem): void {
    log("Menu.append", [item]);
    this.items.push(item);
  }

  insert(pos: number, item: MenuItem): void {
    log("Menu.insert", [pos, item]);
    const index = Math.max(0, Math.min(pos, this.items.length));
    this.items.splice(index, 0, item);
  }

  popup(...args: unknown[]): void {
    log("Menu.popup", args);
  }
}

class MenuItem {
  checked?: boolean;
  click?: (...args: unknown[]) => unknown;
  enabled?: boolean;
  id?: string;
  label?: string;
  role?: string;
  submenu?: Menu;
  type?: string;
  visible?: boolean;

  constructor(...args: unknown[]) {
    log("new MenuItem", args);
    const [options] = args as [Record<string, unknown>?];
    if (!options || typeof options !== "object") {
      return;
    }
    this.checked =
      typeof options.checked === "boolean" ? options.checked : undefined;
    this.click =
      typeof options.click === "function"
        ? (options.click as (...args: unknown[]) => unknown)
        : undefined;
    this.enabled =
      typeof options.enabled === "boolean" ? options.enabled : undefined;
    this.id = typeof options.id === "string" ? options.id : undefined;
    this.label = typeof options.label === "string" ? options.label : undefined;
    this.role = typeof options.role === "string" ? options.role : undefined;
    this.type = typeof options.type === "string" ? options.type : undefined;
    this.visible =
      typeof options.visible === "boolean" ? options.visible : undefined;

    const submenu = options.submenu;
    if (Array.isArray(submenu)) {
      this.submenu = Menu.buildFromTemplate(submenu);
      return;
    }
    if (submenu instanceof Menu) {
      this.submenu = submenu;
    }
  }
}

class Tray {
  constructor(...args: unknown[]) {
    log("new Tray", args);
  }
}

class Notification {
  constructor(...args: unknown[]) {
    log("new Notification", args);
  }

  show(): void {
    log("Notification.show", []);
  }
}

const dialog = {
  async showMessageBox(...args: unknown[]): Promise<{ response: number }> {
    log("dialog.showMessageBox", args);
    return { response: 0 };
  },
};

const crashReporter = {
  start(...args: unknown[]): void {
    log("crashReporter.start", args);
  },
};

// Stale-while-revalidate for the read-only chatgpt.com calls every new app
// view makes in sequence before the composer renders (~0.3-0.5 s each from
// the host). A cached copy answers at once and a background fetch refreshes it
// for the next load. Keyed per account (authorization header), 200s only.
const STARTUP_FETCH_PATTERNS = [
  /\/backend-api\/wham\/statsig\/bootstrap(\?|$)/,
  /\/backend-api\/accounts\/check\//,
  /\/backend-api\/settings\/user(\?|$)/,
  /\/backend-api\/wham\/(sites\/access|onboarding\/context|usage|tasks\/list)(\?|$)/,
  /\/backend-api\/celsius\/ws\/user(\?|$)/,
  /\/backend-api\/(automations|subscriptions|beacons\/home)(\?|$)/,
];
type CachedStartupResponse = {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
  at: number;
};
const startupFetchCache = new Map<string, CachedStartupResponse>();
const startupFetchInFlight = new Map<string, Promise<Response>>();

function startupFetchCacheKey(
  input: unknown,
  init: RequestInit,
  headers: Headers,
): string | null {
  if (process.env.CODEX_WEB_NO_FETCH_CACHE) return null;
  if (typeof input !== "string" && !(input instanceof URL)) return null;
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  if (!STARTUP_FETCH_PATTERNS.some((pattern) => pattern.test(url))) return null;
  // Only the statsig bootstrap is a POST; its body is per-session noise.
  if (method !== "GET" && !/statsig\/bootstrap/.test(url)) return null;
  const account = createHash("sha256")
    .update(`${headers.get("authorization") ?? ""}|${headers.get("chatgpt-account-id") ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `${method} ${url} ${account}`;
}

function responseFromCache(entry: CachedStartupResponse): Response {
  return new Response(entry.body.slice(0), { status: entry.status, headers: entry.headers });
}

async function fetchAndCache(key: string, doFetch: () => Promise<Response>): Promise<Response> {
  const response = await doFetch();
  if (response.status === 200) {
    const body = await response.clone().arrayBuffer();
    startupFetchCache.set(key, {
      status: response.status,
      headers: [...response.headers.entries()].filter(
        ([name]) => !/^(content-encoding|content-length|transfer-encoding|set-cookie)$/i.test(name),
      ),
      body,
      at: Date.now(),
    });
  }
  return response;
}

async function cachedStartupFetch(key: string, doFetch: () => Promise<Response>): Promise<Response> {
  const cached = startupFetchCache.get(key);
  if (cached) {
    if (Date.now() - cached.at > 5_000 && !startupFetchInFlight.has(key)) {
      const refresh = fetchAndCache(key, doFetch).finally(() => startupFetchInFlight.delete(key));
      startupFetchInFlight.set(key, refresh);
      refresh.catch(() => {});
    }
    return responseFromCache(cached);
  }
  return fetchAndCache(key, doFetch);
}

// Statsig writes its maps in a random key order on every fetch, so each new
// payload (~5 MB, loaded by every app view twice plus once as the renderer's
// bootstrap) looked brand new to the socket's big-frame deltas. Sorting object
// keys keeps the meaning (the app only JSON.parses it) and makes consecutive
// payloads differ by a few KB.
const STATSIG_BOOTSTRAP_PATTERN = /\/backend-api\/wham\/statsig\/bootstrap(\?|$)/;

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
  );
}

async function canonicalStatsigResponse(response: Response): Promise<Response> {
  if (response.status !== 200 || process.env.CODEX_WEB_NO_STATSIG_CANON) return response;
  try {
    const body = JSON.parse(await response.clone().text()) as Record<string, unknown>;
    if (typeof body.statsigPayload === "string") {
      body.statsigPayload = JSON.stringify(sortKeysDeep(JSON.parse(body.statsigPayload)));
    }
    const headers = [...response.headers.entries()].filter(
      ([name]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(name),
    );
    return new Response(JSON.stringify(sortKeysDeep(body)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

function electronUserAgent(): string {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Codex/${globalThis.__CODEX_SHIM_VALUES__?.version ?? "0.0.0"} Chrome/152.0.0.0 Electron/41.0.0 Safari/537.36`;
}

const net = {
  isOnline(): boolean {
    return true;
  },
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    // log("net.fetch", [input, init]);
    if (typeof globalThis.fetch === "function") {
      // Electron's net.fetch sends the session user agent; Node's default one
      // gets a Cloudflare 403 from chatgpt.com (dictation /transcribe, etc.).
      const headers = new Headers(init?.headers);
      if (!headers.has("user-agent")) {
        headers.set("user-agent", electronUserAgent());
      }
      const request = { ...init, headers };
      const isStatsigBootstrap =
        (typeof input === "string" || input instanceof URL) && STATSIG_BOOTSTRAP_PATTERN.test(String(input));
      const doFetch = () => {
        const pending = globalThis.fetch(input as URL | RequestInfo, request);
        return isStatsigBootstrap ? pending.then(canonicalStatsigResponse) : pending;
      };
      const cacheKey = startupFetchCacheKey(input, request, headers);
      if (cacheKey == null) {
        return doFetch();
      }
      return cachedStartupFetch(cacheKey, doFetch);
    }
    return new Response("", { status: 204 });
  },
  request(...args: unknown[]): {
    getHeader: (name: string) => string | undefined;
    once: (event: string, listener: StubListener) => unknown;
    setHeader: (name: string, value: string) => void;
  } {
    // log("net.request", args);
    const headers = new Map<string, string>();
    const request = {
      setHeader(name: string, value: string): void {
        // log("net.request.setHeader", [name, value]);
        headers.set(name.toLowerCase(), value);
      },
      getHeader(name: string): string | undefined {
        // log("net.request.getHeader", [name]);
        return headers.get(name.toLowerCase());
      },
      once(event: string, listener: StubListener): unknown {
        // log("net.request.once", [event, listener]);
        return request;
      },
    };
    return request;
  },
};

getIpcMainBridgeState().getWindowById = (id) => BrowserWindow.fromId(id);
const autoUpdater = createEmitterStub("autoUpdater");
const ipcMain = createIpcMainStub();
const nativeTheme = {
  ...createEmitterStub("nativeTheme"),
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  themeSource: "system",
};
// Microphone/camera capture happens in the remote browser (phone, laptop), whose
// own getUserMedia prompt is the real permission gate; the host's TCC state is
// irrelevant, so report access as granted instead of asking macOS.
const systemPreferences = {
  ...createEmitterStub("systemPreferences"),
  getMediaAccessStatus: (mediaType: string): string => {
    log("systemPreferences.getMediaAccessStatus", [mediaType]);
    return "granted";
  },
  askForMediaAccess: async (mediaType: string): Promise<boolean> => {
    log("systemPreferences.askForMediaAccess", [mediaType]);
    return true;
  },
};
// Real enough for the app's icon paths (dock, "open in" editors): a missing
// resize()/toDataURL() threw inside a startup service and the renderer retried
// it on a multi-second backoff before first paint.
const nativeImageCache = new Map<string, Buffer | null>();

function loadImageFile(imagePath: string): Buffer | null {
  if (nativeImageCache.has(imagePath)) return nativeImageCache.get(imagePath)!;
  let buffer: Buffer | null = null;
  try {
    if (imagePath && existsSync(imagePath)) {
      if (/\.png$/i.test(imagePath)) {
        buffer = readFileSync(imagePath);
      } else if (process.platform === "darwin") {
        const out = path.join(tmpdir(), `codex-web-icon-${nativeImageCache.size}.png`);
        execFileSync("sips", ["-s", "format", "png", "-Z", "128", imagePath, "--out", out], { stdio: "ignore" });
        buffer = readFileSync(out);
      }
    }
  } catch {
    buffer = null;
  }
  nativeImageCache.set(imagePath, buffer);
  return buffer;
}

function createNativeImageStub(label: string, buffer: Buffer | null): Record<string, unknown> {
  const image: Record<string, unknown> = {
    isEmpty: () => buffer == null || buffer.length === 0,
    toPNG: () => buffer ?? Buffer.alloc(0),
    toDataURL: () => (buffer ? `data:image/png;base64,${buffer.toString("base64")}` : ""),
    getSize: () => (buffer ? { width: 128, height: 128 } : { width: 0, height: 0 }),
    getAspectRatio: () => 1,
    isTemplateImage: () => false,
    setTemplateImage: () => undefined,
    addRepresentation: () => undefined,
  };
  image.resize = () => image;
  image.crop = () => image;
  return new Proxy(image, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (typeof prop === "symbol") return undefined;
      return createDeepStub(`${label}.${prop}`);
    },
  });
}

const nativeImage = {
  createEmpty(): Record<string, unknown> {
    log("nativeImage.createEmpty", []);
    return createNativeImageStub("nativeImage(empty)", null);
  },
  createFromPath(imagePath: string): Record<string, unknown> {
    log("nativeImage.createFromPath", [imagePath]);
    return createNativeImageStub(`nativeImage(${imagePath})`, loadImageFile(imagePath));
  },
  createFromBuffer(buffer: Buffer): Record<string, unknown> {
    return createNativeImageStub("nativeImage(buffer)", buffer ?? null);
  },
  createFromDataURL(dataUrl: string): Record<string, unknown> {
    const match = /^data:[^;]+;base64,(.*)$/.exec(dataUrl ?? "");
    return createNativeImageStub("nativeImage(dataURL)", match ? Buffer.from(match[1]!, "base64") : null);
  },
};
const powerMonitor = {
  ...createEmitterStub("powerMonitor"),
  getSystemIdleState(_idleThreshold: number): string {
    return "unknown";
  },
  getSystemIdleTime(): number {
    return 0;
  },
  isOnBatteryPower(): boolean {
    return false;
  },
};
// Desktop shortcuts and sleep inhibitors have no native window in the web host.
const globalShortcut = {
  register(...args: unknown[]): boolean {
    log("globalShortcut.register", args);
    return false;
  },
  isRegistered(_accelerator: string): boolean {
    return false;
  },
  unregister(...args: unknown[]): void {
    log("globalShortcut.unregister", args);
  },
  unregisterAll(): void {},
};
const powerSaveBlocker = {
  start(type: string): number {
    log("powerSaveBlocker.start", [type]);
    return 0;
  },
  stop(id: number): void {
    log("powerSaveBlocker.stop", [id]);
  },
  isStarted(_id: number): boolean {
    return false;
  },
};
const screen = {
  ...createEmitterStub("screen"),
  isCursorScreenPointSupported(): boolean {
    return false;
  },
  getAllDisplays(): Array<{
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  }> {
    log("screen.getAllDisplays", []);
    return [this.getPrimaryDisplay()];
  },
  getDisplayMatching(): {
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  } {
    log("screen.getDisplayMatching", []);
    return this.getPrimaryDisplay();
  },
  getPrimaryDisplay(): {
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  } {
    log("screen.getPrimaryDisplay", []);
    return {
      id: 1,
      scaleFactor: 2,
      size: { width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      workAreaSize: { width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    };
  },
};
const protocol = {
  registerSchemesAsPrivileged(...args: unknown[]): void {
    log("protocol.registerSchemesAsPrivileged", args);
  },
  handle(...args: unknown[]): void {
    log("protocol.handle", args);
  },
  registerStringProtocol(...args: unknown[]): void {
    log("protocol.registerStringProtocol", args);
  },
};
function createSessionStub(label: string): {
  cookies: ReturnType<typeof createEmitterStub> & {
    get: (...args: unknown[]) => Promise<unknown[]>;
    remove: (...args: unknown[]) => Promise<void>;
    set: (...args: unknown[]) => Promise<void>;
  };
  getUserAgent: () => string;
  getDownloadHistory: () => Promise<unknown[]>;
  loadExtension: (extensionPath: string) => Promise<{
    id: string;
    name: string;
    path: string;
    version: string;
  }>;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  protocol: typeof protocol;
  removeListener: (event: string, listener: StubListener) => unknown;
  setPermissionCheckHandler: (...args: unknown[]) => void;
  setPermissionPromptHandler: (...args: unknown[]) => void;
  setPermissionRequestHandler: (...args: unknown[]) => void;
  setPreferredLanguages: (languages: string[]) => void;
  setWebsiteReportingEnabled: (enabled: boolean) => void;
  webRequest: {
    onBeforeRequest: (...args: unknown[]) => void;
    onBeforeSendHeaders: (...args: unknown[]) => void;
  };
} {
  const emitter = createEmitterStub(label);
  return {
    cookies: {
      ...createEmitterStub(`${label}.cookies`),
      async get(...args: unknown[]): Promise<unknown[]> {
        log(`${label}.cookies.get`, args);
        return [];
      },
      async remove(...args: unknown[]): Promise<void> {
        log(`${label}.cookies.remove`, args);
      },
      async set(...args: unknown[]): Promise<void> {
        log(`${label}.cookies.set`, args);
      },
    },
    async getDownloadHistory(): Promise<unknown[]> {
      return [];
    },
    async loadExtension(extensionPath: string): Promise<{
      id: string;
      name: string;
      path: string;
      version: string;
    }> {
      log(`${label}.loadExtension`, [extensionPath]);
      return {
        id: "stub-extension",
        name: "Stub Extension",
        path: extensionPath,
        version: "0.0.0",
      };
    },
    getUserAgent(): string {
      log(`${label}.getUserAgent`, []);
      return electronUserAgent();
    },
    off: emitter.off,
    on: emitter.on,
    once: emitter.once,
    protocol,
    removeListener: emitter.removeListener,
    setPermissionCheckHandler(...args: unknown[]): void {
      log(`${label}.setPermissionCheckHandler`, args);
    },
    setPermissionPromptHandler(...args: unknown[]): void {
      log(`${label}.setPermissionPromptHandler`, args);
    },
    setPermissionRequestHandler(...args: unknown[]): void {
      log(`${label}.setPermissionRequestHandler`, args);
    },
    setPreferredLanguages(languages: string[]): void {
      log(`${label}.setPreferredLanguages`, [languages]);
    },
    setWebsiteReportingEnabled(enabled: boolean): void {
      log(`${label}.setWebsiteReportingEnabled`, [enabled]);
    },
    webRequest: {
      onBeforeRequest(...args: unknown[]): void {
        log(`${label}.webRequest.onBeforeRequest`, args);
      },
      onBeforeSendHeaders(...args: unknown[]): void {
        log(`${label}.webRequest.onBeforeSendHeaders`, args);
      },
    },
  };
}
const partitionSessions = new Map<
  string,
  ReturnType<typeof createSessionStub>
>();
const session = {
  defaultSession: createSessionStub("session.defaultSession"),
  fromPartition(partition: string): ReturnType<typeof createSessionStub> {
    log("session.fromPartition", [partition]);
    let partitionSession = partitionSessions.get(partition);
    if (!partitionSession) {
      partitionSession = createSessionStub(
        `session.fromPartition(${partition})`,
      );
      partitionSessions.set(partition, partitionSession);
    }
    return partitionSession;
  },
};
const utilityProcess = {
  fork: undefined,
};
const webContents = {
  fromId(id: number): Record<string, unknown> | undefined {
    log("webContents.fromId", [id]);
    return BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === id,
    )?.webContents;
  },
  getAllWebContents(): Record<string, unknown>[] {
    log("webContents.getAllWebContents", []);
    return BrowserWindow.getAllWindows().map((window) => window.webContents);
  },
  getFocusedWebContents(): Record<string, unknown> | null {
    log("webContents.getFocusedWebContents", []);
    return BrowserWindow.getFocusedWindow()?.webContents ?? null;
  },
};
class MessageChannelMain {
  port1 = createMessagePortStub("MessageChannelMain.port1");
  port2 = createMessagePortStub("MessageChannelMain.port2");
}

const electronModule = new Proxy(
  {
    app,
    BrowserWindow,
    ipcMain,
    autoUpdater,
    crashReporter,
    MessageChannelMain,
    Menu,
    MenuItem,
    net,
    nativeImage,
    nativeTheme,
    Notification,
    powerMonitor,
    powerSaveBlocker,
    globalShortcut,
    protocol,
    screen,
    session,
    systemPreferences,
    Tray,
    utilityProcess,
    WebContentsView,
    webContents,
    dialog,
  } as Record<string, unknown>,
  {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof typeof target];
      }

      return createDeepStub(`electron.${String(prop)}`);
    },
  },
);

export {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItem,
  MessageChannelMain,
  net,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  globalShortcut,
  protocol,
  screen,
  session,
  systemPreferences,
  Tray,
  utilityProcess,
  WebContentsView,
  webContents,
  crashReporter,
  dialog,
};
export default electronModule;
