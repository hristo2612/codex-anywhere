// Big-frame delta encoding for the renderer socket.
//
// Every app view boots with ~20 MB of statsig JSON (the statsig_evaluations
// shared object twice, plus the /wham/statsig/bootstrap body as base64) and
// uploads the 5 MB object once more. It changes a little on every fetch, so
// neither HTTP caching nor a content hash helps, and over a Tailscale relay it
// dominated phone load times. Each side keeps the big payloads it has seen per
// "slot"; big frames then travel as a delta against a payload the other side
// is known to hold (see src/server/frame-delta-codec.ts).

import { createHash } from "node:crypto";

import { applyDelta, encodeDelta, sampleSum, type DeltaPayload } from "./frame-delta-codec";

export { applyDelta, encodeDelta, sampleSum, type DeltaOp, type DeltaPayload } from "./frame-delta-codec";

export type BigFrameMeta = {
  slot: string;
  hash: string;
  // "frame": the diffed text is the message's own JSON.
  // "bytes": the diffed text is the decoded (latin1) body of a ["bytes", b64]
  // node inside a message-port message; `path` locates it.
  kind: "frame" | "bytes";
};

export function textHash(text: string): string {
  return createHash("sha1").update(text, "utf8").update(String(text.length)).digest("base64url");
}

// Texts the browser may hold as a base, by hash. Bounded; a miss only means a
// full frame is sent.
export class BaseStore {
  private readonly entries = new Map<string, string>();
  constructor(private readonly maxEntries = 8) {}

  get(hash: string): string | undefined {
    const text = this.entries.get(hash);
    if (text !== undefined) {
      this.entries.delete(hash);
      this.entries.set(hash, text);
    }
    return text;
  }

  put(hash: string, text: string): void {
    this.entries.delete(hash);
    this.entries.set(hash, text);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

type BytesNode = { holder: unknown[]; index: number; path: number[] };

// Finds the largest ["bytes", "<base64>"] node in a message-port payload.
export function findLargestBytesNode(data: unknown, minLength: number): BytesNode | null {
  let best: BytesNode | null = null;
  let bestLength = minLength - 1;
  const visit = (value: unknown, path: number[], depth: number): void => {
    if (!Array.isArray(value) || depth > 12) return;
    if (value.length === 2 && value[0] === "bytes" && typeof value[1] === "string") {
      if (value[1].length > bestLength) {
        bestLength = value[1].length;
        best = { holder: value, index: 1, path: [...path, 1] };
      }
      return;
    }
    value.forEach((item, i) => visit(item, [...path, i], depth + 1));
  };
  visit(data, [], 0);
  return best;
}

// Per-connection state: what the browser holds.
export type DeltaPeer = {
  // Its base per slot, and the frame seq that base dates from.
  bases: Map<string, { hash: string; seq: number }>;
  // Texts it holds (it may send deltas against any of them), newest last.
  knownTexts: Map<string, string>;
  // It asked for plain frames (a delta failed there earlier).
  disabled: boolean;
};

export function newDeltaPeer(): DeltaPeer {
  return { bases: new Map(), knownTexts: new Map(), disabled: false };
}

type BigFrame = { slot: string; kind: BigFrameMeta["kind"]; text: string; path?: number[]; holder?: unknown[] };

// Frame layouts (the browser side is src/browser/frame-delta.ts):
//   {"s":n,"m":msg}                      ordinary frame
//   {"s":n,"b":meta,"m":msg}             big frame, whole ("m" last: its JSON is the base text)
//   {"s":n,"b":meta,"p":path,"m":msg}    big bytes frame, whole
//   {"s":n,"b":meta,"d":delta}           big frame as a delta against the browser's base for the slot
//   browser -> server {"s":n,"u":delta}  big frame as a delta against any text we hold
export class FrameDeltaServer {
  private readonly store = new BaseStore();
  private readonly minChars: number;
  private readonly disabled: boolean;
  private readonly debug: boolean;

  constructor(options: { minChars?: number; disabled?: boolean; debug?: boolean } = {}) {
    this.minChars = options.minChars ?? 128 * 1024;
    this.disabled = options.disabled ?? false;
    this.debug = options.debug ?? false;
  }

  private remember(peer: DeltaPeer, hash: string, text: string): void {
    peer.knownTexts.delete(hash);
    peer.knownTexts.set(hash, text);
    while (peer.knownTexts.size > 8) {
      const oldest = peer.knownTexts.keys().next().value;
      if (oldest === undefined) break;
      peer.knownTexts.delete(oldest);
    }
  }

  private lookup(peer: DeltaPeer, hash: string): string | undefined {
    return peer.knownTexts.get(hash) ?? this.store.get(hash);
  }

  private describe(message: unknown, messageJson: string): BigFrame | null {
    const envelope = message as {
      type?: string;
      channel?: string;
      data?: unknown;
      args?: { type?: string; key?: string; hostId?: string; message?: { method?: string } }[];
    };
    if (envelope.type === "message-port-message") {
      const node = findLargestBytesNode(envelope.data, this.minChars / 2);
      if (!node) return null;
      const text = Buffer.from(node.holder[node.index] as string, "base64").toString("latin1");
      return { slot: `bytes:${text.slice(0, 48)}`, kind: "bytes", text, path: node.path, holder: node.holder };
    }
    const arg = envelope.args?.[0];
    const slot = [envelope.type, envelope.channel, arg?.type, arg?.key ?? arg?.hostId, arg?.message?.method].join("|");
    return { slot: `frame:${slot}`, kind: "frame", text: messageJson };
  }

  encode(peer: DeltaPeer, seq: number, message: unknown): string {
    const messageJson = JSON.stringify(message);
    const plain = `{"s":${seq},"m":${messageJson}}`;
    if (this.disabled || peer.disabled || messageJson.length < this.minChars) return plain;
    try {
      const big = this.describe(message, messageJson);
      if (!big) return plain;
      const hash = textHash(big.text);
      const metaJson = JSON.stringify({ slot: big.slot, hash, kind: big.kind } satisfies BigFrameMeta);
      const known = peer.bases.get(big.slot);
      const baseText = known ? this.lookup(peer, known.hash) : undefined;
      this.store.put(hash, big.text);
      peer.bases.set(big.slot, { hash, seq });
      this.remember(peer, hash, big.text);
      const ops = known && baseText !== undefined ? encodeDelta(baseText, big.text) : null;
      if (known && ops) {
        let template = "";
        if (big.kind === "bytes" && big.holder && big.path) {
          const index = big.path[big.path.length - 1]!;
          const original = big.holder[index];
          big.holder[index] = "";
          template = `,"tpl":${JSON.stringify(message)},"path":${JSON.stringify(big.path)}`;
          big.holder[index] = original;
        }
        const delta = `{"base":${JSON.stringify(known.hash)},"ops":${JSON.stringify(ops)},"len":${big.text.length},"sum":${sampleSum(big.text)}${template}}`;
        if (this.debug) console.log(`[frame-delta] ${big.slot.slice(0, 60)} ${messageJson.length} -> ${delta.length} chars`);
        return `{"s":${seq},"b":${metaJson},"d":${delta}}`;
      }
      if (big.kind === "bytes") return `{"s":${seq},"b":${metaJson},"p":${JSON.stringify(big.path)},"m":${messageJson}}`;
      return `{"s":${seq},"b":${metaJson},"m":${messageJson}}`;
    } catch (error) {
      console.error("[frame-delta] sending a plain frame", error);
      peer.bases.clear();
      return plain;
    }
  }

  // The browser declares the bases it loaded from IndexedDB; keep those we
  // still have the text for and return them. `at` is the last frame it had
  // processed; slots we sent since then are newer and stay as they are.
  acceptDeclared(peer: DeltaPeer, declared: unknown, at: number): [string, string][] {
    if (!Array.isArray(declared)) return [];
    const next = new Map<string, string>();
    for (const entry of declared) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
      const text = this.lookup(peer, entry[1]);
      if (text === undefined) continue;
      next.set(entry[0], entry[1]);
      this.remember(peer, entry[1], text);
    }
    for (const [slot, current] of peer.bases) {
      if (current.seq <= at && !next.has(slot)) peer.bases.delete(slot);
    }
    for (const [slot, hash] of next) {
      const current = peer.bases.get(slot);
      if (!current || current.seq <= at) peer.bases.set(slot, { hash, seq: at });
    }
    return [...next];
  }

  // A big frame the browser sent as a delta; throws if we can't rebuild it.
  decodeUpload(peer: DeltaPeer, delta: unknown): unknown {
    const payload = delta as DeltaPayload;
    const base = typeof payload?.base === "string" ? this.lookup(peer, payload.base) : undefined;
    if (base === undefined) throw new Error("unknown delta base");
    return JSON.parse(applyDelta(base, payload));
  }
}
