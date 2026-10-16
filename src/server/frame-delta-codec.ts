// Delta codec shared by the server (src/server/frame-delta.ts) and the browser
// (src/browser/frame-delta.ts). Pure; no Node or DOM APIs.
//
// rsync-style: the receiver already holds `base`; ops are literal strings or
// (start, length) copies from base. Matches are verified by exact comparison,
// so a hash collision can never corrupt the result, and the receiver checks
// the length and a sampled checksum before trusting it.

export type DeltaOp = number | string;

export type DeltaPayload = {
  base: string;
  ops: DeltaOp[];
  len: number;
  sum: number;
};

const BLOCK = 256;
const BASE_MUL = 0x01000193;

function pow32(base: number, exp: number): number {
  let result = 1;
  for (let i = 0; i < exp; i += 1) result = Math.imul(result, base) >>> 0;
  return result;
}
const DROP_MUL = pow32(BASE_MUL, BLOCK - 1);

function blockHash(text: string, start: number): number {
  let h = 0;
  for (let i = start; i < start + BLOCK; i += 1) {
    h = (Math.imul(h, BASE_MUL) + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

function sameRange(a: string, aStart: number, b: string, bStart: number, len: number): boolean {
  for (let i = 0; i < len; i += 1) {
    if (a.charCodeAt(aStart + i) !== b.charCodeAt(bStart + i)) return false;
  }
  return true;
}

// Ops: a string is a literal; two numbers are a copy of base[start, start+len).
// Returns null when the delta would not save much.
export function encodeDelta(base: string, next: string): DeltaOp[] | null {
  if (base.length < BLOCK || next.length < BLOCK) return null;
  const index = new Map<number, number>();
  for (let start = 0; start + BLOCK <= base.length; start += BLOCK) {
    const h = blockHash(base, start);
    if (!index.has(h)) index.set(h, start);
  }

  const ops: DeltaOp[] = [];
  let literalBytes = 0;
  let literalStart = 0;
  let p = 0;
  let h = blockHash(next, 0);
  while (p + BLOCK <= next.length) {
    const candidate = index.get(h);
    if (candidate !== undefined && sameRange(next, p, base, candidate, BLOCK)) {
      // Grow the match backwards into the pending literal, then forwards.
      let from = candidate;
      let at = p;
      while (at > literalStart && from > 0 && next.charCodeAt(at - 1) === base.charCodeAt(from - 1)) {
        at -= 1;
        from -= 1;
      }
      let len = p + BLOCK - at;
      const maxLen = Math.min(next.length - at, base.length - from);
      while (len + 4096 <= maxLen && next.startsWith(base.slice(from + len, from + len + 4096), at + len)) {
        len += 4096;
      }
      while (len < maxLen && next.charCodeAt(at + len) === base.charCodeAt(from + len)) len += 1;

      if (at > literalStart) {
        ops.push(next.slice(literalStart, at));
        literalBytes += at - literalStart;
      }
      ops.push(from, len);
      p = at + len;
      literalStart = p;
      if (p + BLOCK <= next.length) h = blockHash(next, p);
      continue;
    }
    if (p + BLOCK >= next.length) break;
    h = (Math.imul((h - Math.imul(next.charCodeAt(p), DROP_MUL)) >>> 0, BASE_MUL) + next.charCodeAt(p + BLOCK)) >>> 0;
    p += 1;
  }
  if (literalStart < next.length) {
    ops.push(next.slice(literalStart));
    literalBytes += next.length - literalStart;
  }
  return literalBytes > next.length / 2 ? null : ops;
}

// Cheap integrity check over ~4k evenly spaced characters plus both ends.
export function sampleSum(text: string): number {
  let h = 0x811c9dc5 ^ text.length;
  const mix = (code: number) => {
    h = Math.imul(h ^ code, 0x01000193) >>> 0;
  };
  const edge = Math.min(256, text.length);
  for (let i = 0; i < edge; i += 1) mix(text.charCodeAt(i));
  for (let i = text.length - edge; i < text.length; i += 1) mix(text.charCodeAt(i));
  const step = Math.max(1, Math.floor(text.length / 4096));
  for (let i = 0; i < text.length; i += step) mix(text.charCodeAt(i));
  return h >>> 0;
}

export function applyDelta(base: string, delta: DeltaPayload): string {
  const parts: string[] = [];
  const { ops } = delta;
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (typeof op === "string") {
      parts.push(op);
      continue;
    }
    const len = ops[i + 1];
    if (typeof op !== "number" || typeof len !== "number") throw new Error("malformed delta");
    parts.push(base.slice(op, op + len));
    i += 1;
  }
  const text = parts.join("");
  if (text.length !== delta.len || sampleSum(text) !== delta.sum) {
    throw new Error("delta checksum mismatch");
  }
  return text;
}
