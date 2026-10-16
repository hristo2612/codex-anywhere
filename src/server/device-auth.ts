// Device login for codex-anywhere. Anyone who reaches the server can run
// commands on the host, so every HTTP request and WebSocket upgrade needs a
// paired device, wherever it comes from: a proxy such as `tailscale serve`
// connects from loopback, so loopback proves nothing.
//
// Pairing: `node scripts/pair.mjs --name iphone` on the host prints a
// short-lived, single-use code; the device enters it on the pairing page and
// gets a long-lived HttpOnly cookie. Only hashes are stored, in
// ~/.codex-anywhere/devices.json (mode 600). `node scripts/devices.mjs`
// lists and revokes devices; the running server notices within a second and
// closes the revoked device's sockets.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

// `__Host-` cookies must be Secure, so plain-HTTP origins (127.0.0.1 during
// development) use the second name.
export const SECURE_COOKIE = "__Host-codex-anywhere";
export const PLAIN_COOKIE = "codex-anywhere-device";
// Browsers cap cookie lifetime at 400 days; each page load renews it.
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const TOKEN_PREFIX = "cad1_";
// Crockford base32: no I, L, O or U, so a code read aloud is unambiguous.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
// The long form of a code (120 bits) cannot be guessed, so it skips the
// attempt limit: the owner can always pair, even while someone floods the
// pairing page with wrong short codes.
const LONG_CODE_LENGTH = 24;
export const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
/**
 * The only paths the pairing page returns to by itself: the app's start page
 * and a thread. A link from another site reaches the pairing page without the
 * cookie, and that return is what adds it.
 */
export const PAIRING_RETURN_PATH = /^\/(?:thread\/[A-Za-z0-9._~%-]+)?$/;
export const MAX_CODE_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_CODES = 5;
const MAX_DEVICES = 50;
const MAX_NAME_LENGTH = 40;
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 10_000;

export type Device = {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  userAgent?: string;
  /** Only local-tools devices expire; paired devices last until revoked. */
  expiresAt?: string;
};

type PairingCode = {
  codeHash: string;
  salt: string;
  longHash: string;
  name: string;
  createdAt: string;
  expiresAt: string;
};

type StoreFile = {
  version: 1;
  devices: Device[];
  pairingCodes: PairingCode[];
};

export function defaultStateDir(): string {
  return process.env.CODEX_ANYWHERE_STATE_DIR || path.join(os.homedir(), ".codex-anywhere");
}

const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
export const hashToken = (token: string): string => sha256(`codex-anywhere-device-token:${token}`);
// Codes are short (40 bits), so their stored hashes are salted and slow: a
// process that can read devices.json cannot recover a pending code in time.
const hashCode = (code: string, salt: string): string =>
  crypto.scryptSync(`codex-anywhere-pairing-code:${code}`, Buffer.from(salt, "hex"), 32, { N: 16384, r: 8, p: 1 }).toString("hex");

/** Uppercases and maps look-alikes (O->0, I/L->1), dropping spaces and dashes. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function newCode(length: number): string {
  let code = "";
  // 256 is a multiple of 32, so `byte % 32` is unbiased.
  for (const byte of crypto.randomBytes(length)) code += CODE_ALPHABET[byte % 32];
  return code;
}

export const formatCode = (code: string): string => code.match(/.{1,4}/g)!.join("-");
const hashLongCode = (code: string): string => sha256(`codex-anywhere-pairing-long-code:${code}`);
const codeShaped = (code: string): boolean =>
  (code.length === CODE_LENGTH || code.length === LONG_CODE_LENGTH) && [...code].every((char) => CODE_ALPHABET.includes(char));
/** True for the long, unguessable form of a pairing code. */
export const isLongCode = (input: string): boolean => {
  const code = normalizeCode(input);
  return code.length === LONG_CODE_LENGTH && codeShaped(code);
};
const sameHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
};

export function cleanDeviceName(name: unknown): string {
  const cleaned = String(name ?? "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || "device";
}

const emptyStore = (): StoreFile => ({ version: 1, devices: [], pairingCodes: [] });
const isExpired = (device: Device, now: number): boolean =>
  device.expiresAt !== undefined && !(Date.parse(device.expiresAt) > now);

function parseStore(text: string): StoreFile {
  const data = JSON.parse(text) as Partial<StoreFile>;
  if (data?.version !== 1 || !Array.isArray(data.devices) || !Array.isArray(data.pairingCodes)) {
    throw new Error("unexpected devices.json format");
  }
  for (const device of data.devices) {
    if (typeof device?.id !== "string" || typeof device.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(device.tokenHash)) {
      throw new Error("devices.json has a malformed device entry");
    }
  }
  for (const code of data.pairingCodes) {
    if (
      typeof code?.codeHash !== "string" ||
      typeof code.salt !== "string" ||
      typeof code.longHash !== "string" ||
      typeof code.expiresAt !== "string"
    ) {
      throw new Error("devices.json has a malformed pairing code entry");
    }
  }
  return data as StoreFile;
}

function addDeviceTo(
  state: StoreFile,
  name: string,
  userAgent: string,
  now: number,
  ttlMs?: number,
): { token: string; device: Device } {
  if (state.devices.length >= MAX_DEVICES) {
    throw new Error(`already ${MAX_DEVICES} devices; revoke some with scripts/devices.mjs`);
  }
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const device: Device = {
    id: `dev_${crypto.randomBytes(5).toString("hex")}`,
    name,
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}),
    ...(ttlMs ? { expiresAt: new Date(now + ttlMs).toISOString() } : {}),
  };
  state.devices.push(device);
  return { token, device };
}

/** Where `scripts/devices.mjs local-token` keeps a token for local test tools. */
export const localTokenFile = (dir = defaultStateDir()): string => path.join(dir, "local-token");

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The devices file, shared by the server and the CLIs. Reads are served from
 * memory and refreshed when the file changes; writes take a lock file and
 * replace the file atomically. If the file is unreadable, malformed or not
 * private to this user, no device authenticates (fail closed).
 */
export class DeviceStore {
  readonly file: string;
  readonly seenFile: string;
  private state: StoreFile = emptyStore();
  private byTokenHash = new Map<string, Device>();
  private byId = new Map<string, Device>();
  private stamp = "";
  private problem: string | null = "not loaded";
  private changes = 0;

  constructor(readonly dir: string = defaultStateDir()) {
    this.file = path.join(dir, "devices.json");
    this.seenFile = path.join(dir, "devices-seen.json");
  }

  /** Counts reloads, so callers that share the store can tell it changed. */
  get generation(): number {
    return this.changes;
  }

  /** Why no device can authenticate right now, or null when the store is fine. */
  get error(): string | null {
    return this.problem;
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory()) throw new Error(`${this.dir} is not a directory`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`${this.dir} is owned by another user`);
    }
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(this.dir, 0o700);
  }

  /** Re-reads the file if it changed since the last read. Returns true if it did. */
  refresh(): boolean {
    // The folder is checked every time: if anyone else could write to it,
    // they could have replaced the file.
    try {
      const dir = fs.lstatSync(this.dir);
      if (!dir.isDirectory()) return this.fail(`${this.dir} is not a directory`);
      if (typeof process.getuid === "function" && dir.uid !== process.getuid()) {
        return this.fail(`${this.dir} is owned by another user`);
      }
      if ((dir.mode & 0o022) !== 0) return this.fail(`${this.dir} is writable by others`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return this.fail(`cannot check ${this.dir}: ${(error as Error).message}`);
      }
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return this.fail(`cannot read ${this.file}: ${(error as Error).message}`);
      }
      if (this.stamp === "missing") return false;
      this.stamp = "missing";
      this.apply(emptyStore());
      return true;
    }
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode}`;
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    if (!stat.isFile()) return this.fail(`${this.file} is not a regular file`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return this.fail(`${this.file} is owned by another user`);
    }
    // Writable by others: its contents cannot be trusted. Only readable by
    // others: tighten it (the stored hashes are not secrets on their own).
    if ((stat.mode & 0o022) !== 0) return this.fail(`${this.file} is writable by others`);
    if ((stat.mode & 0o044) !== 0) {
      try {
        fs.chmodSync(this.file, 0o600);
      } catch (error) {
        return this.fail(`${this.file} is readable by others: ${(error as Error).message}`);
      }
    }
    try {
      this.apply(parseStore(fs.readFileSync(this.file, "utf8")));
    } catch (error) {
      return this.fail(`cannot use ${this.file}: ${(error as Error).message}`);
    }
    return true;
  }

  authenticate(token: string, now = Date.now()): Device | null {
    if (this.problem || !token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
    const device = this.byTokenHash.get(hashToken(token));
    return device && !isExpired(device, now) ? device : null;
  }

  isActive(deviceId: string, now = Date.now()): boolean {
    const device = this.problem ? undefined : this.byId.get(deviceId);
    return device !== undefined && !isExpired(device, now);
  }

  /** When the newest pending code was made (0 if none), so the gate can reset its limiter. */
  newestCodeAt(now = Date.now()): number {
    let newest = 0;
    for (const code of this.state.pairingCodes) {
      if (Date.parse(code.expiresAt) > now) newest = Math.max(newest, Date.parse(code.createdAt) || 0);
    }
    return newest;
  }

  devices(): Device[] {
    return this.state.devices.map((device) => ({ ...device }));
  }

  pendingCodes(now = Date.now()): { name: string; expiresAt: string }[] {
    return this.state.pairingCodes
      .filter((code) => Date.parse(code.expiresAt) > now)
      .map(({ name, expiresAt }) => ({ name, expiresAt }));
  }

  /** A pairing code in two forms (either works, once): short to type, long to paste. */
  createPairingCode(
    name: string,
    ttlMs = DEFAULT_CODE_TTL_MS,
    now = Date.now(),
  ): { code: string; longCode: string; name: string; expiresAt: string } {
    const ttl = Math.min(Math.max(ttlMs, 60_000), MAX_CODE_TTL_MS);
    const code = newCode(CODE_LENGTH);
    const longCode = newCode(LONG_CODE_LENGTH);
    const salt = crypto.randomBytes(16).toString("hex");
    const entry: PairingCode = {
      codeHash: hashCode(code, salt),
      salt,
      longHash: hashLongCode(longCode),
      name: cleanDeviceName(name),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    this.mutate((state) => {
      state.pairingCodes = state.pairingCodes.filter((pending) => Date.parse(pending.expiresAt) > now);
      state.pairingCodes.push(entry);
      state.pairingCodes.splice(0, Math.max(0, state.pairingCodes.length - MAX_PENDING_CODES));
    });
    return { code: formatCode(code), longCode: formatCode(longCode), name: entry.name, expiresAt: entry.expiresAt };
  }

  /**
   * The slow hashes of a short code under each pending code's salt, computed
   * off the event loop; pass them to redeemPairingCode.
   */
  async shortCodeHashes(input: string, now = Date.now()): Promise<Map<string, string>> {
    const code = normalizeCode(input);
    const hashes = new Map<string, string>();
    if (code.length !== CODE_LENGTH || !codeShaped(code)) return hashes;
    this.refresh();
    for (const pending of this.state.pairingCodes) {
      if (!(Date.parse(pending.expiresAt) > now)) continue;
      const key = await new Promise<Buffer>((resolve, reject) =>
        crypto.scrypt(`codex-anywhere-pairing-code:${code}`, Buffer.from(pending.salt, "hex"), 32, { N: 16384, r: 8, p: 1 }, (error, derived) =>
          error ? reject(error) : resolve(derived),
        ),
      );
      hashes.set(pending.salt, key.toString("hex"));
    }
    return hashes;
  }

  /** Spends a pairing code (either form) on a new device. Null when the code is wrong, used or expired. */
  redeemPairingCode(
    input: string,
    userAgent = "",
    now = Date.now(),
    precomputed?: Map<string, string>,
  ): { token: string; device: Device } | null {
    const code = normalizeCode(input);
    if (!codeShaped(code)) return null;
    const long = code.length === LONG_CODE_LENGTH;
    return this.mutate((state) => {
      state.pairingCodes = state.pairingCodes.filter((pending) => Date.parse(pending.expiresAt) > now);
      const index = state.pairingCodes.findIndex((pending) =>
        long
          ? sameHex(pending.longHash, hashLongCode(code))
          : sameHex(pending.codeHash, precomputed?.get(pending.salt) ?? hashCode(code, pending.salt)),
      );
      if (index < 0) return null;
      const [pending] = state.pairingCodes.splice(index, 1);
      return addDeviceTo(state, pending!.name, userAgent, now);
    });
  }

  /** Adds an expiring device without a code, for local tools (scripts/devices.mjs local-token). */
  addDevice(name: string, ttlMs: number, now = Date.now()): { token: string; device: Device } {
    return this.mutate((state) => addDeviceTo(state, cleanDeviceName(name), "", now, Math.max(ttlMs, 60_000)));
  }

  /** Revokes devices by id, or by name when that name is unique. Returns the revoked devices. */
  revoke(idOrName: string): Device[] {
    return this.mutate((state) => {
      const byId = state.devices.filter((device) => device.id === idOrName);
      const matches = byId.length > 0 ? byId : state.devices.filter((device) => device.name === idOrName);
      if (matches.length > 1) {
        throw new Error(`${matches.length} devices are named "${idOrName}"; revoke by id (${matches.map((d) => d.id).join(", ")})`);
      }
      state.devices = state.devices.filter((device) => !matches.includes(device));
      return matches;
    });
  }

  revokeAll(): Device[] {
    return this.mutate((state) => {
      const all = state.devices;
      state.devices = [];
      state.pairingCodes = [];
      return all;
    });
  }

  clearPairingCodes(): number {
    return this.mutate((state) => {
      const count = state.pairingCodes.length;
      state.pairingCodes = [];
      return count;
    });
  }

  /** Last time each device was seen, written by the server only (no lock needed). */
  readSeen(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.seenFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  writeSeen(seen: Record<string, string>): void {
    const temp = `${this.seenFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(seen), { mode: 0o600 });
    fs.renameSync(temp, this.seenFile);
  }

  private fail(problem: string): boolean {
    this.changes += 1;
    this.problem = problem;
    this.byTokenHash = new Map();
    this.byId = new Map();
    // Look again next time, even if the file itself does not change (a
    // transient read error, or the folder's mode being fixed).
    this.stamp = "";
    return true;
  }

  private apply(state: StoreFile): void {
    this.changes += 1;
    this.state = state;
    this.byTokenHash = new Map(state.devices.map((device) => [device.tokenHash, device]));
    this.byId = new Map(state.devices.map((device) => [device.id, device]));
    this.problem = null;
  }

  private mutate<T>(change: (state: StoreFile) => T): T {
    this.ensureDir();
    return this.withLock(() => {
      this.stamp = "";
      this.refresh();
      if (this.problem) throw new Error(`${this.problem}; fix or remove it first`);
      const next = structuredClone(this.state);
      const result = change(next);
      const temp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.file);
      this.refresh();
      return result;
    });
  }

  private withLock<T>(work: () => T): T {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lock, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A lock left by a crashed writer: remove it only if it is still the
        // same file, so a lock another writer just took is never removed.
        try {
          const held = fs.statSync(lock);
          if (Date.now() - held.mtimeMs > LOCK_STALE_MS && fs.statSync(lock).ino === held.ino) fs.rmSync(lock, { force: true });
        } catch {}
        if (Date.now() > deadline) throw new Error(`${lock} is held; try again`);
        sleepSync(20);
      }
    }
    try {
      return work();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
}

/**
 * Failed pairing attempts, counted globally: behind a proxy every request
 * comes from the same address, so per-address limits would mean nothing.
 * Past the hourly budget, pending codes are burned and a new one is needed.
 */
export class AttemptLimiter {
  private failures: number[] = [];

  constructor(
    private readonly perMinute = 5,
    private readonly perHour = 30,
  ) {}

  /** Forgets past failures: the owner just made a new code. */
  reset(): void {
    this.failures = [];
  }

  /** Seconds to wait before another attempt is allowed, or 0. */
  retryAfter(now = Date.now()): number {
    this.failures = this.failures.filter((at) => now - at < 3_600_000);
    if (this.failures.length >= this.perHour) {
      return Math.ceil((this.failures[0]! + 3_600_000 - now) / 1000);
    }
    const recent = this.failures.filter((at) => now - at < 60_000);
    if (recent.length >= this.perMinute) return Math.ceil((recent[0]! + 60_000 - now) / 1000);
    return 0;
  }

  /** Records a failure; true when the hourly budget just ran out. */
  fail(now = Date.now()): boolean {
    this.failures.push(now);
    return this.failures.filter((at) => now - at < 3_600_000).length === this.perHour;
  }

  /** Takes back a failure recorded up front for an attempt that succeeded. */
  undo(at: number): void {
    const index = this.failures.lastIndexOf(at);
    if (index >= 0) this.failures.splice(index, 1);
  }
}

export type PublicFile = { file: string; contentType: string };

export type GateOptions = {
  store: DeviceStore;
  /** Unauthenticated, non-sensitive files (manifest, icons) by exact path. */
  publicFiles?: Record<string, PublicFile>;
  /** Extra exact origins allowed for WebSockets and writes, e.g. a proxy that rewrites Host. */
  allowedOrigins?: string[];
  /**
   * Clients reach the server over HTTPS even though no header says so (a TLS
   * proxy that sends no X-Forwarded-Proto): Secure cookie, https origins only.
   */
  publicHttps?: boolean;
  limiter?: AttemptLimiter;
  log?: (message: string) => void;
  now?: () => number;
};

export type UpgradeDecision =
  | { ok: true; device: Device }
  | { ok: false; status: 401 | 403; reason: string };

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
const firstListValue = (value: string | undefined): string | undefined => value?.split(",")[0]?.trim() || undefined;
const isSafeMethod = (method: string): boolean => method === "GET" || method === "HEAD" || method === "OPTIONS";

function cookieValues(req: IncomingMessage): { name: string; value: string }[] {
  const values: { name: string; value: string }[] = [];
  for (const part of (header(req, "cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name === SECURE_COOKIE || name === PLAIN_COOKIE) values.push({ name, value: part.slice(index + 1).trim() });
  }
  return values;
}

export class DeviceGate {
  private readonly store: DeviceStore;
  private readonly publicFiles: Map<string, PublicFile>;
  private readonly allowedOrigins: Set<string>;
  private readonly limiter: AttemptLimiter;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly publicHttps: boolean;
  private limiterEpoch = 0;
  // Keep-alive HTTP connections by the device that last used them, so a
  // revocation can cut them (a long download, say) instead of waiting.
  private readonly connections = new Map<Socket, string>();
  private readonly seen: Record<string, string>;
  private seenDirty = false;
  private seenTimer: NodeJS.Timeout | null = null;
  private refusals = 0;
  private refusalTimer: NodeJS.Timeout | null = null;

  constructor(options: GateOptions) {
    this.store = options.store;
    this.publicFiles = new Map(Object.entries(options.publicFiles ?? {}));
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => origin.trim().toLowerCase()).filter(Boolean));
    this.limiter = options.limiter ?? new AttemptLimiter();
    this.log = options.log ?? ((message) => console.log(`[device-auth] ${message}`));
    this.now = options.now ?? Date.now;
    this.publicHttps = Boolean(options.publicHttps);
    this.seen = this.store.readSeen();
  }

  /** The paired device a request's cookie belongs to, if any. */
  deviceFor(req: IncomingMessage): { device: Device; cookie: { name: string; value: string } } | null {
    // One stat per request (the file is re-read only when it changed): a
    // revocation or a device added by the CLI applies to the next request.
    this.store.refresh();
    for (const cookie of cookieValues(req)) {
      const device = this.store.authenticate(cookie.value);
      if (device) return { device, cookie };
    }
    return null;
  }

  /**
   * Runs before the app sees a request. Returns true when the gate answered it
   * (refused it, or served a pairing route); false means: pass it on.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    // Other ports on the same host are "same-site", so SameSite alone does not
    // stop a page served there from framing this one.
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");

    const method = (req.method ?? "GET").toUpperCase();
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      this.send(res, 400, { error: "bad_request" });
      return true;
    }

    // Fetch metadata: from another site (or another port of this host), only
    // plain top-level page loads are allowed, never subresources or writes.
    const fetchSite = header(req, "sec-fetch-site");
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      const dest = header(req, "sec-fetch-dest");
      const topLevelLoad =
        (method === "GET" || method === "HEAD") &&
        header(req, "sec-fetch-mode") === "navigate" &&
        (dest === undefined || dest === "document");
      if (!topLevelLoad) return this.refuse(res, 403, "cross_origin");
    }
    if (!isSafeMethod(method) && !this.originAllowed(req, false)) return this.refuse(res, 403, "bad_origin");

    if (pathname === "/__auth/pair" && method === "POST") {
      void this.handlePair(req, res);
      return true;
    }
    const auth = this.deviceFor(req);
    if (pathname === "/__auth/status" && (method === "GET" || method === "HEAD")) {
      this.send(res, auth ? 200 : 401, auth ? { paired: true, device: auth.device.name } : { paired: false });
      return true;
    }
    const publicFile = this.publicFiles.get(pathname);
    if (publicFile && (method === "GET" || method === "HEAD")) {
      this.servePublicFile(res, publicFile, method === "HEAD");
      return true;
    }

    if (!auth) {
      if ((method === "GET" || method === "HEAD") && this.isPageLoad(req)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(method === "HEAD" ? undefined : PAIRING_PAGE);
        this.noteRefusal();
        return true;
      }
      return this.refuse(res, 401, "unauthorized");
    }

    this.markSeen(auth.device.id);
    this.trackConnection(req.socket, auth.device.id);
    if (pathname === "/__auth/pair") {
      res.statusCode = 303;
      res.setHeader("Location", "/");
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return true;
    }
    if (method === "GET" && this.isPageLoad(req)) {
      const secure = auth.cookie.name === SECURE_COOKIE || this.isSecure(req);
      const cookies = [this.cookieHeader(auth.cookie.value, secure)];
      // Moving to the Secure name: drop the plain copy.
      if (secure && auth.cookie.name === PLAIN_COOKIE) cookies.push(`${PLAIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
      res.setHeader("Set-Cookie", cookies);
    }
    return false;
  }

  /** Cuts open HTTP connections of devices that are no longer paired. */
  dropRevokedConnections(): void {
    for (const [socket, deviceId] of this.connections) {
      if (this.store.isActive(deviceId)) continue;
      this.connections.delete(socket);
      socket.destroy();
    }
  }

  private trackConnection(socket: Socket, deviceId: string): void {
    if (this.connections.get(socket) === deviceId) return;
    if (!this.connections.has(socket)) socket.once("close", () => this.connections.delete(socket));
    this.connections.set(socket, deviceId);
  }

  /** Decides a WebSocket upgrade: same-origin page and a paired device. */
  authorizeUpgrade(req: IncomingMessage): UpgradeDecision {
    const fetchSite = header(req, "sec-fetch-site");
    if (!this.originAllowed(req, true) || (fetchSite !== undefined && fetchSite !== "same-origin")) {
      this.noteRefusal();
      return { ok: false, status: 403, reason: "bad_origin" };
    }
    const auth = this.deviceFor(req);
    if (!auth) {
      this.noteRefusal();
      return { ok: false, status: 401, reason: "unauthorized" };
    }
    this.markSeen(auth.device.id);
    return { ok: true, device: auth.device };
  }

  /**
   * The Origin must be this server as the client addressed it: the scheme the
   * connection or proxy reports (never the Origin's own), and the Host or a
   * proxy's X-Forwarded-Host, port included, since SameSite treats every port
   * and, in some browsers, both schemes of a host as one site. Browsers cannot
   * forge any of these headers.
   */
  originAllowed(req: IncomingMessage, required: boolean): boolean {
    const origin = header(req, "origin");
    if (origin === undefined) return !required;
    if (this.allowedOrigins.has(origin.toLowerCase())) return true;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    const scheme = this.isSecure(req) ? "https:" : "http:";
    if (parsed.protocol !== scheme) return false;
    const defaultPortSuffix = scheme === "https:" ? ":443" : ":80";
    const wanted = parsed.host.toLowerCase();
    for (const candidate of [header(req, "host"), firstListValue(header(req, "x-forwarded-host"))]) {
      if (!candidate) continue;
      let host = candidate.trim().toLowerCase();
      if (host.endsWith(defaultPortSuffix)) host = host.slice(0, -defaultPortSuffix.length);
      if (host === wanted) return true;
    }
    return false;
  }

  /**
   * Runs before the plugin-page sandbox server (PORT+1) sees a request.
   * Returns true when the gate answered it (a refusal); false means: serve it.
   *
   * The sandbox shell is static, but it shares the app's hostname, and
   * browsers send the device cookie to every port of a host. So it is gated
   * like the app, and it only ever answers two kinds of request:
   *   - the app framing it: a same-site iframe navigation (the app is PORT);
   *   - the shell loading its own files: same-origin subresources.
   * Never a top-level page, never another site, never a write. A page cannot
   * be opened on the sandbox origin by a link or a popup, so script can only
   * run there inside the app's own iframe.
   */
  handleSandboxRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return this.refuse(res, 405, "method_not_allowed");
    }
    try {
      new URL(req.url ?? "/", "http://localhost");
    } catch {
      this.send(res, 400, { error: "bad_request" });
      return true;
    }
    const site = header(req, "sec-fetch-site");
    const mode = header(req, "sec-fetch-mode");
    const dest = header(req, "sec-fetch-dest");
    if (dest === "document" || site === "none" || site === "cross-site") return this.refuse(res, 403, "sandbox_framed_only");
    if (site === "same-site" && !(mode === "navigate" && dest === "iframe")) return this.refuse(res, 403, "sandbox_framed_only");
    const auth = this.deviceFor(req);
    if (!auth) return this.refuse(res, 401, "unauthorized");
    this.trackConnection(req.socket, auth.device.id);
    return false;
  }

  /** "https:" or "http:": how the client reached the server, never what its Origin claims. */
  requestScheme(req: IncomingMessage): "https:" | "http:" {
    return this.isSecure(req) ? "https:" : "http:";
  }

  /** Whether the client reached the server over HTTPS (directly or through the proxy). */
  private isSecure(req: IncomingMessage): boolean {
    if (this.publicHttps) return true;
    if ((req.socket as { encrypted?: boolean }).encrypted) return true;
    return firstListValue(header(req, "x-forwarded-proto"))?.toLowerCase() === "https";
  }

  private isPageLoad(req: IncomingMessage): boolean {
    const mode = header(req, "sec-fetch-mode");
    if (mode !== undefined) return mode === "navigate";
    return (header(req, "accept") ?? "").includes("text/html");
  }

  private cookieHeader(token: string, secure: boolean): string {
    return [
      `${secure ? SECURE_COOKIE : PLAIN_COOKIE}=${token}`,
      "Path=/",
      `Max-Age=${COOKIE_MAX_AGE_S}`,
      "HttpOnly",
      "SameSite=Strict",
      // Chrome evicts low-priority cookies first when a host has too many,
      // so a page on another port of this host cannot flood this one out.
      "Priority=High",
      ...(secure ? ["Secure"] : []),
    ].join("; ");
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.originAllowed(req, true)) {
        this.refuse(res, 403, "bad_origin");
        return;
      }
      if (!(header(req, "content-type") ?? "").toLowerCase().startsWith("application/json")) {
        this.send(res, 415, { error: "expected_json" });
        return;
      }
      const body = await readBody(req, 2048);
      let code = "";
      try {
        code = String((JSON.parse(body) as { code?: unknown })?.code ?? "").slice(0, 64);
      } catch {}
      const now = this.now();
      const long = isLongCode(code);
      let exhausted = false;
      if (!long) {
        // A code made after the last failures gets a fresh budget.
        this.store.refresh();
        const newest = this.store.newestCodeAt(now);
        if (newest > this.limiterEpoch) {
          this.limiterEpoch = newest;
          this.limiter.reset();
        }
        const wait = this.limiter.retryAfter(now);
        if (wait > 0) {
          res.setHeader("Retry-After", String(wait));
          this.send(res, 429, { error: "too_many_attempts", retryAfter: wait });
          return;
        }
        // Counted before the (async) check, so parallel attempts cannot all
        // slip past the limit; taken back if the code turns out right.
        exhausted = this.limiter.fail(now);
      }
      const precomputed = long ? undefined : await this.store.shortCodeHashes(code, now);
      const paired = this.store.redeemPairingCode(code, header(req, "user-agent") ?? "", now, precomputed);
      if (!paired) {
        this.log(`pairing attempt with a wrong or expired code`);
        if (exhausted) {
          const burned = this.store.clearPairingCodes();
          this.log(`too many failed pairing attempts: ${burned} pending code(s) burned; make a new one`);
        }
        this.send(res, 401, { error: "invalid_code" });
        return;
      }
      if (!long) this.limiter.undo(now);
      this.log(`paired device ${paired.device.id} (${paired.device.name})`);
      res.setHeader("Set-Cookie", this.cookieHeader(paired.token, this.isSecure(req)));
      // A fresh start for the HTTP cache: files this server once sent as
      // immutable may have been patched since (browsers honour this in secure
      // contexts, which includes 127.0.0.1). Cookies and storage are kept.
      res.setHeader("Clear-Site-Data", '"cache"');
      this.send(res, 200, { ok: true, device: paired.device.name });
    } catch (error) {
      this.log(`pairing failed: ${(error as Error).message}`);
      if (!res.headersSent) this.send(res, (error as { status?: number }).status === 413 ? 413 : 500, { error: "pairing_failed" });
      else res.destroy();
    }
  }

  private servePublicFile(res: ServerResponse, publicFile: PublicFile, headOnly: boolean): void {
    fs.readFile(publicFile.file, (error, data) => {
      if (error) {
        this.send(res, 404, { error: "not_found" });
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", publicFile.contentType);
      res.setHeader("Cache-Control", "no-cache");
      res.end(headOnly ? undefined : data);
    });
  }

  private refuse(res: ServerResponse, status: number, error: string): true {
    this.noteRefusal();
    this.send(res, status, { error });
    return true;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  // One summary line a minute at most, so a scanner cannot flood the log.
  private noteRefusal(): void {
    this.refusals += 1;
    if (this.refusalTimer) return;
    this.refusalTimer = setTimeout(() => {
      this.refusalTimer = null;
      this.log(`refused ${this.refusals} unauthenticated request(s) in the last minute`);
      this.refusals = 0;
    }, 60_000);
    this.refusalTimer.unref();
  }

  private markSeen(deviceId: string): void {
    const now = this.now();
    const last = Date.parse(this.seen[deviceId] ?? "") || 0;
    if (now - last < 60_000) return;
    this.seen[deviceId] = new Date(now).toISOString();
    this.seenDirty = true;
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      if (!this.seenDirty) return;
      this.seenDirty = false;
      try {
        this.store.writeSeen(this.seen);
      } catch (error) {
        this.log(`could not record last-seen times: ${(error as Error).message}`);
      }
    }, 5_000);
    this.seenTimer.unref();
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Writes a bare HTTP refusal on a socket whose upgrade was declined. */
export function refuseUpgrade(socket: { write: (data: string) => unknown; destroy: () => void }, status: 401 | 403): void {
  const text = status === 401 ? "Unauthorized" : "Forbidden";
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

// Self-contained (no external requests), shown in place of any page while the
// device is unpaired. It also covers a SameSite=Strict quirk: a page opened
// from a link on another site arrives without the cookie, so it asks the
// server (same-origin, cookie included) and reloads once if already paired.
const PAIRING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<link rel="manifest" href="/manifest.json">
<title>Pair this device</title>
<style>
:root { --bg: #f5f5f7; --card: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --field: #f5f5f7; --accent: #111111; --accent-fg: #ffffff; --ring: rgba(0, 0, 0, 0.12); --error: #d70015; }
@media (prefers-color-scheme: dark) { :root { --bg: #000000; --card: #1c1c1e; --fg: #f5f5f7; --muted: #98989d; --line: #3a3a3c; --field: #2c2c2e; --accent: #f5f5f7; --accent-fg: #000000; --ring: rgba(255, 255, 255, 0.2); --error: #ff453a; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; }
body { min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
main { width: 100%; max-width: 380px; background: var(--card); border-radius: 24px; padding: 32px 24px 22px; text-align: center; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 40px rgba(0, 0, 0, 0.07); }
@media (prefers-color-scheme: dark) { main { box-shadow: none; border: 1px solid var(--line); } }
.mark { width: 60px; height: 60px; margin: 0 auto 20px; border-radius: 16px; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; }
.mark svg { width: 28px; height: 28px; }
h1 { font-size: 24px; line-height: 1.2; font-weight: 650; letter-spacing: -0.015em; margin: 0 0 8px; }
p { color: var(--muted); font-size: 15px; margin: 0 auto 24px; max-width: 30ch; text-wrap: balance; }
input { width: 100%; height: 60px; font: 600 26px/1 ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; letter-spacing: 0.14em; text-align: center; text-transform: uppercase; padding: 0 12px; border: 1.5px solid var(--line); border-radius: 14px; background: var(--field); color: var(--fg); outline: none; -webkit-appearance: none; appearance: none; transition: border-color 0.15s, box-shadow 0.15s; }
input::placeholder { color: var(--muted); opacity: 0.45; }
input:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--ring); }
button { width: 100%; height: 52px; margin-top: 12px; font: inherit; font-weight: 600; border: 0; border-radius: 14px; background: var(--accent); color: var(--accent-fg); cursor: pointer; -webkit-tap-highlight-color: transparent; transition: transform 0.1s, opacity 0.15s; }
button:active { transform: scale(0.98); }
button:disabled { opacity: 0.5; }
#msg { min-height: 1.45em; margin-top: 12px; font-size: 15px; color: var(--error); }
.note { font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg></div>
<h1>Pair this device</h1>
<p>Enter the code from the Mac running Codex Anywhere.</p>
<form id="form" autocomplete="off">
<input id="code" name="code" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="one-time-code" maxlength="40" placeholder="XXXX-XXXX" aria-label="Pairing code" required>
<button id="go" type="submit">Pair</button>
</form>
<div id="msg" role="status"></div>
<div class="note">Each code works once and expires soon.</div>
</main>
<script>
(() => {
  const form = document.getElementById("form");
  const input = document.getElementById("code");
  const button = document.getElementById("go");
  const msg = document.getElementById("msg");
  // Always an absolute URL on this origin: a path like //host or /\\host
  // must not turn into a different site.
  const here = () => location.origin + "/" + location.pathname.replace(/^[\\\\/]+/, "") + location.search;
  // Where to go once paired, or once the status check finds this device
  // paired. A link from another site lands here without the cookie, and
  // this reload is what adds it, so it may only reach an app route (never a
  // file under /@fs/ or a plugin page) and never keeps the query (which can
  // pre-fill a prompt). Everything else goes to the app's start page.
  const target = () => location.origin + (${PAIRING_RETURN_PATH}.test(location.pathname) ? location.pathname : "/");
  const ready = () => dispatchEvent(new CustomEvent("codex-web:ready", { detail: { path: location.pathname } }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    msg.textContent = "";
    try {
      const response = await fetch("/__auth/pair", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: input.value }),
      });
      if (response.ok) {
        location.replace(target());
        return;
      }
      const body = await response.json().catch(() => ({}));
      msg.textContent =
        response.status === 429
          ? "Too many attempts. Wait " + (body.retryAfter || 60) + " seconds and try again."
          : response.status === 401
            ? "That code is wrong, used or expired. Make a new one on the computer."
            : "Pairing failed (" + response.status + ").";
    } catch {
      msg.textContent = "Could not reach the server.";
    }
    button.disabled = false;
  });
  // A pairing link (.../__auth/pair#code=XXXX-XXXX) fills in and submits
  // the code; the fragment never reaches the server or its logs.
  let hashCode = "";
  try { hashCode = decodeURIComponent(location.hash.replace(/^#(code=)?/, "")).slice(0, 40); } catch {}
  if (hashCode) {
    input.value = hashCode;
    try { history.replaceState(null, "", here()); } catch {}
  }
  fetch("/__auth/status", { cache: "no-store", credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) {
        ready();
        if (hashCode) form.requestSubmit();
        return;
      }
      let last = 0;
      try { last = Number(sessionStorage.getItem("codexAnywhereAuthBounce")) || 0; } catch {}
      if (Date.now() - last < 10000) return ready();
      try { sessionStorage.setItem("codexAnywhereAuthBounce", String(Date.now())); } catch {}
      location.replace(target());
    })
    .catch(ready);
})();
</script>
</body>
</html>
`;
