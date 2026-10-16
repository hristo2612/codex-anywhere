#!/usr/bin/env node
// Downloads OpenAI's MCP App sandbox shell (the page the desktop app loads into
// codex-sandbox://*.web-sandbox.oaiusercontent.com) and every asset it imports
// into scratch/mcp-sandbox, so MCP App pages render from this machine with no
// request to oaiusercontent.com at view time. Run at install/upgrade time, like
// the app zip in scripts/prepare; the files are not redistributed.
//
// usage: node scripts/mirror_mcp_sandbox.mjs [--origin https://web-sandbox.oaiusercontent.com] [--out scratch/mcp-sandbox]
import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    origin: {
      type: "string",
      default: "https://web-sandbox.oaiusercontent.com",
    },
    out: { type: "string", default: "scratch/mcp-sandbox" },
  },
});
const origin = values.origin.replace(/\/$/, "");
const out = path.resolve(values.out);
const staging = `${out}.tmp-${process.pid}`;

class NotFound extends Error {}

async function get(pathname) {
  const response = await fetch(`${origin}${pathname}`, { redirect: "error" });
  if (response.status === 404) throw new NotFound(`${pathname}: HTTP 404`);
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Only flat files under /assets/ are ever written (no "..", no subfolders).
const safeAsset = (pathname) =>
  /^\/assets\/[A-Za-z0-9_.@-]+$/.test(pathname) && !pathname.includes("..");

const seen = new Set();
let written = 0;
const queue = [];
const enqueue = (pathname) => {
  if (!safeAsset(pathname) || seen.has(pathname)) return;
  seen.add(pathname);
  queue.push(pathname);
};

await rm(staging, { recursive: true, force: true });
try {
  await mkdir(path.join(staging, "assets"), { recursive: true });
  const html = (await get("/mcp-app.html")).toString("utf8");
  await writeFile(path.join(staging, "mcp-app.html"), html);
  written += 1;
  // The entry files the shell page itself loads must all exist.
  const required = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    if (!safeAsset(match[1]))
      throw new Error(`unexpected asset path in mcp-app.html: ${match[1]}`);
    required.add(match[1]);
    enqueue(match[1]);
  }

  while (queue.length > 0) {
    const pathname = queue.shift();
    let body;
    try {
      body = await get(pathname);
    } catch (error) {
      // The import scan is textual; names like tailwind's "./preflight.css" are
      // not real files on the sandbox host. Anything else is a real failure.
      if (!(error instanceof NotFound) || required.has(pathname)) throw error;
      console.warn(`[mcp-sandbox] skipped ${error.message}`);
      continue;
    }
    await writeFile(path.join(staging, pathname), body);
    written += 1;
    if (!/\.(js|mjs|css)$/.test(pathname)) continue;
    const text = body.toString("utf8");
    // Static and dynamic imports between chunks: "./x.js", "/assets/x.js", url(./x.woff2)
    for (const match of text.matchAll(
      /["'(](\.\/|\/assets\/|assets\/)([A-Za-z0-9_.@-]+\.(?:js|mjs|css|wasm|woff2?|ttf|png|svg|json))["')]/g,
    )) {
      enqueue(`/assets/${match[2]}`);
    }
  }

  await rm(out, { recursive: true, force: true });
  await rename(staging, out);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  console.error(
    `[mcp-sandbox] mirror failed, previous copy kept: ${error.message}`,
  );
  process.exit(1);
}
console.log(
  `[mcp-sandbox] mirrored ${written} files from ${origin} into ${path.relative(process.cwd(), out)}`,
);
