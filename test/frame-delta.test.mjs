// Round-trips the server encoder and browser decoder on real statsig payloads.
// Usage: node test/frame-delta.test.mjs <fixtures dir> (made by test/capture-big-frames.mjs;
// the fixtures hold account data, so keep them outside the repo)
import { build } from "esbuild";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const server = require("../src/server/frame-delta.js");
const out = await build({ entryPoints: ["src/browser/frame-delta.ts"], bundle: true, write: false, format: "esm", platform: "neutral" });
const browser = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const dir = process.argv[2];
const frames = fs.readdirSync(dir).filter((f) => /^big-\d+-\d+\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).m);
const texts = frames.map((m) => {
  if (m.type === "message-port-message") {
    const node = server.findLargestBytesNode(m.data, 1000);
    return { slot: "bytes", text: Buffer.from(node.holder[node.index], "base64").toString("latin1") };
  }
  return { slot: "frame", text: JSON.stringify(m) };
});

// Synthetic edge cases: identical, tiny edits, length-changing insertions, unrelated.
const base = texts.find((t) => t.slot === "frame").text;
const cases = [
  ["identical", base, base],
  ["insert 1 char mid", base, base.slice(0, 1e6) + "X" + base.slice(1e6)],
  ["delete 7 chars", base, base.slice(0, 2e6) + base.slice(2e6 + 7)],
  ["unrelated", base, "z".repeat(300000)],
  ["prefix change", base, "Q" + base.slice(1)],
];
for (let i = 0; i < texts.length; i++) for (let j = 0; j < texts.length; j++) {
  if (i !== j && texts[i].slot === texts[j].slot) cases.push([`real ${texts[i].slot} ${i}->${j}`, texts[i].text, texts[j].text]);
}
for (const [name, a, b] of cases) {
  const t0 = performance.now();
  const ops = server.encodeDelta(a, b);
  const t1 = performance.now();
  if (ops === null) { console.log(`${name.padEnd(28)} full frame (delta not worth it) enc ${(t1 - t0).toFixed(0)}ms`); continue; }
  const payload = { base: "h", ops, len: b.length, sum: server.sampleSum(b) };
  const wire = JSON.stringify(payload).length;
  const t2 = performance.now();
  const rebuilt = browser.applyDelta(a, JSON.parse(JSON.stringify(payload)));
  const t3 = performance.now();
  assert.equal(rebuilt, b, name);
  assert.equal(browser.sampleSum(b), server.sampleSum(b));
  console.log(`${name.padEnd(28)} ${String(b.length).padStart(9)} -> ${String(wire).padStart(7)} chars  enc ${(t1 - t0).toFixed(0)}ms dec ${(t3 - t2).toFixed(0)}ms`);
}
// A wrong base must be detected, never silently accepted.
const ops = server.encodeDelta(texts[0].text, texts[1].text);
if (ops) assert.throws(() => browser.applyDelta(texts[0].text.replace(/1/g, "2"), { base: "h", ops, len: texts[1].text.length, sum: server.sampleSum(texts[1].text) }));
console.log("ok");
