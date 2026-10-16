#!/usr/bin/env node
// Builds a served copy of the patched webview: scratch/asar/webview stays
// prettier-formatted for patching, scratch/webview-dist gets minified JS/CSS
// plus brotli siblings so remote clients (phones over tailscale) load a few MB
// instead of ~30 MB of formatted source.
//
// The live server serves scratch/webview-dist while this runs, so a full
// build goes to a sibling directory and is swapped in at the end; open tabs
// never see missing files. `--only a,b` re-optimizes just those files (paths
// relative to the webview root, e.g. assets/preload.js) in place, atomically.
import { transform } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants } from "node:zlib";

const source = path.resolve("scratch/asar/webview");
const target = path.resolve("scratch/webview-dist");
const compressible = /\.(js|mjs|css|html|json|svg|txt|map|wasm|webmanifest)$/;
const { values } = parseArgs({ options: { only: { type: "string" } } });

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function minify(file, code) {
  const loader = file.endsWith(".css") ? "css" : "js";
  if (!/\.(js|mjs|css)$/.test(file)) return code;
  try {
    const result = await transform(code, { loader, minify: true, charset: "utf8", legalComments: "none" });
    return result.code;
  } catch (error) {
    console.warn(`[optimize] kept unminified ${path.relative(source, file)}: ${error.message.split("\n")[0]}`);
    return code;
  }
}

async function writeAtomic(file, data) {
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

const totals = { before: 0, after: 0, compressed: 0 };

async function optimizeFile(file, outRoot) {
  const out = path.join(outRoot, path.relative(source, file));
  await fs.mkdir(path.dirname(out), { recursive: true });
  if (!compressible.test(file)) {
    await fs.copyFile(file, out);
    return;
  }
  const original = await fs.readFile(file, "utf8");
  const code = await minify(file, original);
  totals.before += Buffer.byteLength(original);
  totals.after += Buffer.byteLength(code);
  if (code.length > 1024) {
    const br = brotliCompressSync(code, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: code.length },
    });
    // Brotli first: a request between the two writes then gets the new
    // plain file or the old pair, never a stale .br for a new file.
    await writeAtomic(`${out}.br`, br);
    totals.compressed += br.length;
  } else {
    await fs.rm(`${out}.br`, { force: true });
  }
  await writeAtomic(out, code);
}

const mb = (n) => (n / 1e6).toFixed(1);
if (values.only) {
  for (const relative of values.only.split(",").map((item) => item.trim()).filter(Boolean)) {
    await optimizeFile(path.join(source, relative), target);
    console.log(`[optimize] updated ${relative}`);
  }
} else {
  const next = `${target}.next`;
  const previous = `${target}.prev`;
  await fs.rm(next, { recursive: true, force: true });
  for await (const file of walk(source)) await optimizeFile(file, next);
  await fs.rm(previous, { recursive: true, force: true });
  const hadTarget = await fs.stat(target).then(() => true, () => false);
  if (hadTarget) await fs.rename(target, previous);
  await fs.rename(next, target);
  if (hadTarget) await fs.rm(previous, { recursive: true, force: true });
  console.log(`[optimize] text ${mb(totals.before)} MB -> minified ${mb(totals.after)} MB -> brotli ${mb(totals.compressed)} MB`);
}
