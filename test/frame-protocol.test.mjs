// Server FrameDeltaServer <-> browser FrameBases on real (canonicalized) statsig frames.
// Usage: node test/frame-protocol.test.mjs <fixtures dir> (made by test/capture-big-frames.mjs;
// the fixtures hold account data, so keep them outside the repo)
import { build } from "esbuild";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.window = globalThis;
const require = createRequire(import.meta.url);
const { FrameDeltaServer, newDeltaPeer } = require("../src/server/frame-delta.js");
const out = await build({ entryPoints: ["src/browser/frame-delta.ts"], bundle: true, write: false, format: "esm", platform: "neutral" });
const { FrameBases, resolveBigFrame } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const sortDeep = (v) => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v;
const canonPayload = (t) => JSON.stringify(sortDeep(JSON.parse(t)));
const dir = process.argv[2];
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).m;
// What the fetch stub now produces: sorted statsig payloads.
const canonEvals = (m) => { m.args[0].value.payload = canonPayload(m.args[0].value.payload); return m; };
const canonBytes = (m) => {
  const node = m.data[1][3][0];
  const body = JSON.parse(Buffer.from(node[1], "base64").toString("utf8"));
  body.statsigPayload = canonPayload(body.statsigPayload);
  node[1] = Buffer.from(JSON.stringify(sortDeep(body)), "utf8").toString("base64");
  return m;
};
const evalsA = canonEvals(load("big-0-0.json")), evalsB = canonEvals(load("big-0-2.json")), evalsC = canonEvals(load("big-1-2.json"));
const bytesA = canonBytes(load("big-0-1.json")), bytesB = canonBytes(load("big-1-1.json"));

const server = new FrameDeltaServer();
function deliver(browser, frame) {
  const data = JSON.parse(frame);
  return data.b ? resolveBigFrame(browser, frame, data) : data.m;
}
const clone = (x) => structuredClone(x);
let seq = 0;

// 1. Fresh page, no stored bases: whole frames, then deltas within the session.
const peer = newDeltaPeer();
const browser = new FrameBases();
const sizes = [];
for (const msg of [evalsA, bytesA, evalsB, bytesB, evalsC]) {
  const frame = server.encode(peer, ++seq, clone(msg));
  sizes.push(frame.length);
  assert.deepEqual(deliver(browser, frame), msg);
}
console.log("fresh page frame sizes:", sizes.join(", "));
assert.ok(sizes[2] < 20000 && sizes[3] < 20000 && sizes[4] < 20000, "later big frames should be deltas");

// 2. Next page load: bases come from storage, get declared, and the first frames are deltas.
const peer2 = newDeltaPeer();
const browser2 = new FrameBases();
for (const [slot, hash] of browser.declared()) browser2.remember({ slot, hash, kind: "frame" }, browser.text(slot, hash));
const accepted = server.acceptDeclared(peer2, browser2.declared(), 0);
assert.equal(accepted.length, 2);
browser2.acceptServerKnown(accepted);
const sizes2 = [];
for (const msg of [evalsC, bytesB, evalsC]) {
  const frame = server.encode(peer2, ++seq, clone(msg));
  sizes2.push(frame.length);
  assert.deepEqual(deliver(browser2, frame), msg);
}
console.log("next page frame sizes:", sizes2.join(", "));
assert.ok(sizes2.every((n) => n < 5000));

// 3. Upload: the renderer sets statsig_evaluations (same value it was sent).
const upload = { type: "ipc-renderer-invoke", requestId: "ipc_bridge_42", channel: "codex_desktop:message-from-view", args: [{ key: "statsig_evaluations", value: evalsC.args[0].value }] };
const uploadJson = JSON.stringify(upload);
const wire = browser2.encodeOutgoing(99, uploadJson);
assert.ok(wire, "upload should be a delta");
console.log("upload:", uploadJson.length, "->", wire.length, "chars");
assert.deepEqual(server.decodeUpload(peer2, JSON.parse(wire).u), upload);

// 4. A declaration that arrives after we sent a newer base keeps the newer one.
const peer3 = newDeltaPeer();
server.encode(peer3, 10, clone(evalsB));
const slot = [...peer3.bases.keys()][0];
const newer = peer3.bases.get(slot).hash;
server.acceptDeclared(peer3, [[slot, browser2.declared().find(([s]) => s === slot)[1]]], 5);
assert.equal(peer3.bases.get(slot).hash, newer);

// 5. A wrong base is rejected, never silently applied.
assert.throws(() => server.decodeUpload(newDeltaPeer(), { base: "nope", ops: [], len: 0, sum: 0 }));
console.log("ok");
