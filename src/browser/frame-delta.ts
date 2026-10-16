// Browser side of src/server/frame-delta.ts. Keeps the last big payload per
// slot (memory + IndexedDB), rebuilds big frames the server sent as deltas,
// and sends big frames of our own as deltas against payloads the server holds.

import { applyDelta, encodeDelta, sampleSum, type DeltaPayload } from "../server/frame-delta-codec";

export { applyDelta, encodeDelta, sampleSum };

export type BigFrameMeta = {
  slot: string;
  hash: string;
  kind: "frame" | "bytes";
};

type StoredBase = { slot: string; hash: string; text: string };

const DB_NAME = "codex-web-frame-bases";
const STORE = "bases";
const DISABLED_KEY = "codexWebFrameDeltaDisabled";
export const BIG_FRAME_MIN_CHARS = 128 * 1024;
// Texts the server is known to hold for this session, newest last.
const MAX_SERVER_KNOWN = 6;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "slot" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class FrameBases {
  private readonly bases = new Map<string, { hash: string; text: string }>();
  private readonly serverKnown = new Map<string, string>();
  private readonly pendingWrites = new Map<string, StoredBase>();
  private writeTimer: number | null = null;
  private db: Promise<IDBDatabase> | null = null;
  // False after a delta failed in this tab: plain frames only, both ways.
  readonly enabled: boolean;
  // Resolves once stored bases are in memory (or loading failed).
  readonly loaded: Promise<void>;

  constructor() {
    let disabled = false;
    try {
      disabled = sessionStorage.getItem(DISABLED_KEY) === "1";
    } catch {}
    this.enabled = !disabled;
    this.loaded = this.enabled && typeof indexedDB !== "undefined" ? this.load() : Promise.resolve();
  }

  private database(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  private async load(): Promise<void> {
    try {
      const db = await this.database();
      const rows = await new Promise<StoredBase[]>((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result as StoredBase[]);
        request.onerror = () => reject(request.error);
      });
      for (const row of rows) {
        // A frame received while loading is newer than anything stored.
        if (!this.bases.has(row.slot) && typeof row.text === "string") {
          this.bases.set(row.slot, { hash: row.hash, text: row.text });
        }
      }
    } catch (error) {
      console.warn("[codex-web] frame bases unavailable", error);
    }
  }

  declared(): [string, string][] {
    return [...this.bases].map(([slot, { hash }]) => [slot, hash]);
  }

  // After the server failed to decode one of our deltas: send whole frames
  // until it tells us again what it holds.
  forgetServerKnown(): void {
    this.serverKnown.clear();
  }

  // The server confirmed it holds these declared bases.
  acceptServerKnown(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const base = this.bases.get(entry[0]);
      if (base && base.hash === entry[1]) this.markServerKnown(base.hash, base.text);
    }
  }

  private markServerKnown(hash: string, text: string): void {
    this.serverKnown.delete(hash);
    this.serverKnown.set(hash, text);
    while (this.serverKnown.size > MAX_SERVER_KNOWN) {
      const oldest = this.serverKnown.keys().next().value;
      if (oldest === undefined) break;
      this.serverKnown.delete(oldest);
    }
  }

  text(slot: string, hash: string): string | undefined {
    const base = this.bases.get(slot);
    return base?.hash === hash ? base.text : undefined;
  }

  remember(meta: BigFrameMeta, text: string): void {
    this.bases.set(meta.slot, { hash: meta.hash, text });
    this.markServerKnown(meta.hash, text);
    if (!this.enabled || typeof indexedDB === "undefined") return;
    this.pendingWrites.set(meta.slot, { slot: meta.slot, hash: meta.hash, text });
    // Persist just off the startup path; only the latest per slot matters.
    if (this.writeTimer !== null) return;
    this.writeTimer = window.setTimeout(() => this.flush(), 1_000);
  }

  // Writes pending bases now (also called when the page is hidden or closing,
  // so the next load can use them).
  flush(): void {
    if (this.writeTimer !== null) {
      window.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.pendingWrites.size === 0) return;
    const rows = [...this.pendingWrites.values()];
    this.pendingWrites.clear();
    void this.database()
      .then((db) => {
        const store = db.transaction(STORE, "readwrite").objectStore(STORE);
        for (const row of rows) store.put(row);
      })
      .catch(() => {});
  }

  // Our own big frame as {"s","u": delta} against a payload the server holds,
  // or null to send it whole.
  encodeOutgoing(seq: number, messageJson: string): string | null {
    if (!this.enabled || messageJson.length < BIG_FRAME_MIN_CHARS) return null;
    let best: { hash: string; ops: DeltaPayload["ops"]; size: number } | null = null;
    for (const [hash, base] of this.serverKnown) {
      const ops = encodeDelta(base, messageJson);
      if (!ops) continue;
      const size = JSON.stringify(ops).length;
      if (!best || size < best.size) best = { hash, ops, size };
    }
    if (!best) return null;
    const delta = { base: best.hash, ops: best.ops, len: messageJson.length, sum: sampleSum(messageJson) };
    return `{"s":${seq},"u":${JSON.stringify(delta)}}`;
  }

  // A delta we could not apply: use plain frames in this tab and start over.
  static recoverFromFailure(error: unknown): void {
    console.error("[codex-web] frame delta failed; reloading with plain frames", error);
    try {
      sessionStorage.setItem(DISABLED_KEY, "1");
    } catch {}
    try {
      indexedDB.deleteDatabase(DB_NAME);
    } catch {}
    window.location.reload();
  }
}

// Rebuilds a big frame's message and records its text as the slot's new base.
// `raw` is the socket frame exactly as received; `data` is its parse.
export function resolveBigFrame(
  bases: FrameBases,
  raw: string,
  data: {
    s: number;
    b: BigFrameMeta;
    m?: unknown;
    p?: number[];
    d?: DeltaPayload & { tpl?: { data?: unknown }; path?: number[] };
  },
): unknown {
  const meta = data.b;
  if (data.d) {
    const baseText = bases.text(meta.slot, data.d.base);
    if (baseText === undefined) throw new Error(`missing base for ${meta.slot}`);
    const text = applyDelta(baseText, data.d);
    bases.remember(meta, text);
    if (meta.kind === "frame") return JSON.parse(text);
    const message = data.d.tpl;
    if (!message) throw new Error("bytes delta without a template");
    setAtPath(message.data, data.d.path ?? [], btoa(text));
    return message;
  }
  if (meta.kind === "frame") {
    // The server writes `"m":` last, so the message JSON is the frame's tail.
    const prefix = `{"s":${data.s},"b":${JSON.stringify(meta)},"m":`;
    if (!raw.startsWith(prefix)) throw new Error("unexpected big frame layout");
    bases.remember(meta, raw.slice(prefix.length, -1));
    return data.m;
  }
  const b64 = getAtPath((data.m as { data?: unknown } | undefined)?.data, data.p ?? []);
  if (typeof b64 !== "string") throw new Error("big bytes frame without bytes");
  bases.remember(meta, atob(b64));
  return data.m;
}

function getAtPath(root: unknown, path: number[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (!Array.isArray(value)) return undefined;
    value = value[key];
  }
  return value;
}

function setAtPath(root: unknown, path: number[], next: unknown): void {
  let value: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!Array.isArray(value)) throw new Error("bad delta path");
    value = value[path[i]!];
  }
  if (!Array.isArray(value)) throw new Error("bad delta path");
  value[path[path.length - 1]!] = next;
}
