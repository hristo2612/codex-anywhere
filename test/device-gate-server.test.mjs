// End to end: boots the real server (isolated HOME, CODEX_HOME and working
// directory, a free port) and checks the device gate in front of it, using
// the real pairing and device CLIs. Needs a built checkout (npm install).
//   npm run build:server && node --test test/device-gate-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = fs.existsSync(path.join(repo, "scratch/asar/package.json")) && fs.existsSync(path.join(repo, "src/server/main.js"));
const PROTECTED_PORTS = new Set([7777, 7788, 7850, 7860, 7877, 8000, 8200, 8201, 18790]);
const sandboxMirrored = fs.existsSync(path.join(repo, "scratch/mcp-sandbox/mcp-app.html"));

// The server also listens on port + 1 (plugin-page sandbox), so both must be free.
async function freePort() {
  const free = (port) =>
    new Promise((resolve) => {
      const probe = net.createServer().once("error", () => resolve(0));
      probe.listen(port, "127.0.0.1", () => {
        const { port: bound } = probe.address();
        probe.close(() => resolve(bound));
      });
    });
  for (;;) {
    const port = await free(0);
    if (!port || PROTECTED_PORTS.has(port) || PROTECTED_PORTS.has(port + 1)) continue;
    if (await free(port + 1)) return port;
  }
}

function codexCli() {
  try {
    return execFileSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function startServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-anywhere-gate-e2e-"));
  const port = await freePort();
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"), CODEX_CLI_PATH: process.env.CODEX_CLI_PATH || codexCli() };
  delete env.CODEX_ANYWHERE_STATE_DIR;
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const child = spawn(process.execPath, [path.join(repo, "src/server/main.js"), "--port", String(port)], {
    cwd: home,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 30_000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("IPC bridge listening") && (!sandboxMirrored || /\[mcp-sandbox\] (serving|not started)/.test(output))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
  const cli = (script, ...args) => execFileSync(process.execPath, [path.join(repo, "scripts", script), ...args], { env, encoding: "utf8" });
  return {
    base: `http://127.0.0.1:${port}`,
    sandbox: `http://127.0.0.1:${port + 1}`,
    home,
    cli,
    output: () => output,
    async stop() {
      // The server's own children (the codex app-server) outlive it otherwise.
      const descendants = [];
      const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      const walk = (pid) => {
        for (const [childPid, parent] of table) {
          if (parent === pid) {
            descendants.push(childPid);
            walk(childPid);
          }
        }
      };
      walk(child.pid);
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
      for (const pid of descendants) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    },
  };
}

const page = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html" };

// Plain http.request: fetch() adds its own Sec-Fetch-Mode, which would hide
// how page loads are treated.
function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function openSocket(base, headers, query = "") {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/__backend/ipc${query}`, { headers });
    ws.once("message", (data) => resolve({ ok: true, ws, first: JSON.parse(String(data)) }));
    ws.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.once("error", () => resolve({ ok: false, status: 0 }));
  });
}

test("the real server refuses unpaired clients and serves paired ones", { skip: !built && "not built", timeout: 90_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const { base } = server;

  // Unpaired: the pairing page for page loads, 401 for everything else.
  const root = await request(`${base}/`, { headers: page });
  assert.equal(root.status, 401);
  assert.match(root.text, /Pair this device/);
  const index = fs.readFileSync(path.join(repo, fs.existsSync(path.join(repo, "scratch/webview-dist")) ? "scratch/webview-dist" : "scratch/asar/webview", "index.html"), "utf8");
  const asset = index.match(/src="\.\/(assets\/index-[^"]+\.js)"/)?.[1];
  assert.ok(asset, "found the app bundle in index.html");
  for (const pathname of [`/${asset}`, "/@fs/etc/hosts", "/thread/x", "/index.html"]) {
    assert.equal((await request(`${base}${pathname}`)).status, 401, pathname);
  }
  const upload = await request(`${base}/__backend/upload`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: '--x\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\nhi\r\n--x--\r\n',
  });
  assert.equal(upload.status, 401);
  assert.equal((await request(`${base}/manifest.json`)).status, 200);
  assert.deepEqual(await openSocket(base, { origin: base }), { ok: false, status: 401 });

  // Pair with the CLI's code.
  const printed = server.cli("pair.mjs", "--name", "e2e-phone");
  const code = printed.match(/: ([0-9A-Z]{4}-[0-9A-Z]{4})/)?.[1];
  assert.ok(code, printed);
  const stateDir = path.join(server.home, ".codex-anywhere");
  assert.equal(fs.statSync(path.join(stateDir, "devices.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  const paired = await request(`${base}/__auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ code }),
  });
  assert.equal(paired.status, 200);
  const cookie = paired.cookie;

  // Paired: the app, its files and its socket.
  const app = await request(`${base}/`, { headers: { ...page, cookie } });
  assert.equal(app.status, 200);
  assert.ok(app.text.includes(asset));
  assert.equal((await request(`${base}/${asset}`, { headers: { cookie } })).status, 200);
  const file = await request(`${base}/@fs/etc/hosts`, { headers: { cookie } });
  assert.equal(file.status, 200);
  assert.match(file.headers["content-security-policy"], /^sandbox; default-src 'none'/, "a local file never runs as a page of the app");
  assert.equal(file.headers["x-content-type-options"], "nosniff");
  // Junk cookies from another port of the host (a plugin page can set them)
  // must not push requests past the header limit (431).
  const junk = Array.from({ length: 10 }, (_, i) => `junk${i}=${"x".repeat(3900)}`).join("; ");
  assert.equal((await request(`${base}/`, { headers: { ...page, cookie: `${junk}; ${cookie}` } })).status, 200, "40 KB of other cookies still gets through");
  assert.deepEqual(await openSocket(base, { cookie, origin: base.replace(/:\d+$/, ":7777") }), { ok: false, status: 403 });
  const socket = await openSocket(base, { cookie, origin: base });
  assert.equal(socket.ok, true);
  const sessionId = socket.first.hello?.session;
  assert.ok(sessionId, JSON.stringify(socket.first));

  // Another paired device cannot resume this device's session.
  const code2 = server.cli("pair.mjs", "--name", "e2e-laptop").match(/: ([0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  const paired2 = await request(`${base}/__auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ code: code2 }),
  });
  const cookie2 = paired2.cookie;
  const hijack = await openSocket(base, { cookie: cookie2, origin: base }, `?session=${sessionId}&ack=0`);
  assert.equal(hijack.first.hello?.resumeFailed, true);

  // A malformed upgrade request must not take the server down.
  await new Promise((resolve) => {
    const raw = net.connect(Number(new URL(base).port), "127.0.0.1", () => {
      // The key is RFC 6455's sample nonce ("the sample nonce"), not a secret.
      raw.write("GET /__backend/ipc HTTP/1.1\r\nHost: [bad\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"); // gitleaks:allow
    });
    raw.on("close", resolve);
    raw.on("error", resolve);
    raw.resume();
  });
  assert.equal((await request(`${base}/`, { headers: { ...page, cookie: cookie2 } })).status, 200, "still serving after a malformed upgrade");

  // Local test tools: a token file only this user can read, never printed.
  const localOut = server.cli("devices.mjs", "local-token");
  const tokenFile = path.join(stateDir, "local-token");
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  assert.ok(!localOut.includes(token), "the token is not printed");
  const local = await request(`${base}/`, { headers: { ...page, cookie: `codex-anywhere-device=${token}` } });
  assert.equal(local.status, 200);
  server.cli("devices.mjs", "local-token");
  assert.equal((await request(`${base}/`, { headers: { ...page, cookie: `codex-anywhere-device=${token}` } })).status, 401, "a new local token replaces the old one");

  const listed = server.cli("devices.mjs", "list");
  assert.match(listed, /e2e-phone/);
  assert.match(listed, /e2e-laptop/);

  // Revoke: the open socket closes with 4401, and nothing more gets through.
  const closed = new Promise((resolve) => socket.ws.once("close", (closeCode) => resolve(closeCode)));
  assert.match(server.cli("devices.mjs", "revoke", "e2e-phone"), /revoked dev_/);
  assert.equal(await closed, 4401);
  assert.equal((await request(`${base}/`, { headers: { ...page, cookie } })).status, 401);
  assert.deepEqual(await openSocket(base, { cookie, origin: base }), { ok: false, status: 401 });
  assert.equal((await request(`${base}/`, { headers: { ...page, cookie: cookie2 } })).status, 200, "other devices keep working");
  assert.match(server.output(), /paired device dev_[0-9a-f]+ \(e2e-phone\)/);
  assert.match(server.output(), /device revoked/);
});

test("the real server's plugin-page sandbox answers paired devices, framed by the app only", { skip: (!built && "not built") || (!sandboxMirrored && "sandbox shell not mirrored"), timeout: 90_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const { base, sandbox } = server;
  assert.match(server.output(), /\[mcp-sandbox\] serving/);
  const asFrame = { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
  const shellPath = "/?app=skybridge&locale=en-US&deviceType=desktop&unsafeSkipTargetOriginCheck=true";

  // Unpaired: nothing from the sandbox either.
  assert.equal((await request(`${sandbox}${shellPath}`, { headers: asFrame })).status, 401);
  assert.equal((await request(`${sandbox}/mcp-app.html`)).status, 401);
  const asset = fs.readFileSync(path.join(repo, "scratch/mcp-sandbox/mcp-app.html"), "utf8").match(/src="(\/assets\/[^"]+\.js)"/)[1];
  assert.equal((await request(`${sandbox}${asset}`)).status, 401);

  const code = server.cli("pair.mjs", "--name", "e2e-sandbox").match(/: ([0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  const { cookie } = await request(`${base}/__auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ code }),
  });

  // The app framing the shell, and the shell loading its own files.
  const shell = await request(`${sandbox}${shellPath}`, { headers: { cookie, ...asFrame } });
  assert.equal(shell.status, 200);
  assert.match(shell.text, /<title>sandbox<\/title>/);
  assert.match(shell.headers["content-security-policy"], new RegExp(`frame-ancestors ${base.replace(/[.]/g, "\\.")};`), "only the app may frame it");
  assert.match(shell.headers["content-security-policy"], /sandbox allow-scripts/);
  const script = await request(`${sandbox}${asset}`, { headers: { cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "script" } });
  assert.equal(script.status, 200);
  assert.match(script.headers["cache-control"], /^private/);

  // Never top-level, never from another site.
  for (const headers of [
    { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
  ]) {
    assert.equal((await request(`${sandbox}${shellPath}`, { headers: { cookie, ...headers } })).status, 403, JSON.stringify(headers));
  }

  // Revoked: the sandbox refuses the device too.
  server.cli("devices.mjs", "revoke", "e2e-sandbox");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await request(`${sandbox}${shellPath}`, { headers: { cookie, ...asFrame } })).status, 401);
});
