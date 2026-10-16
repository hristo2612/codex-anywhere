// The device gate and the plugin-page sandbox together. The sandbox shell is
// served on PORT+1 of the same host: browsers send the device cookie there
// too and count both ports as one site, so a page running on the sandbox
// origin must not be able to use the cookie against the app, and the
// sandbox itself must answer only paired devices, only inside the app.
//   npm run build:server && node --test test/plugin-sandbox.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const { DeviceStore, DeviceGate, refuseUpgrade } = require("../src/server/device-auth.js");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-anywhere-sandbox-test-"));
const listen = (server, port = 0) => new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server.address().port)));

// Two servers wired like src/server/main.ts: the app behind handleRequest and
// authorizeUpgrade, the sandbox on the next port behind handleSandboxRequest,
// one gate and one store for both.
async function startPair() {
  const store = new DeviceStore(tempDir());
  store.refresh();
  const gate = new DeviceGate({ store, log: () => {} });
  const reached = { app: [], sandbox: [] };
  const app = http.createServer((req, res) => {
    if (gate.handleRequest(req, res)) return;
    reached.app.push(`${req.method} ${req.url}`);
    res.end("app");
  });
  const wss = new WebSocketServer({ noServer: true });
  app.on("upgrade", (req, socket, head) => {
    const decision = gate.authorizeUpgrade(req);
    if (!decision.ok) return refuseUpgrade(socket, decision.status);
    wss.handleUpgrade(req, socket, head, (ws) => ws.send("hello"));
  });
  const sandbox = http.createServer((req, res) => {
    if (gate.handleSandboxRequest(req, res)) return;
    reached.sandbox.push(`${req.method} ${req.url}`);
    res.end("sandbox shell");
  });
  let appPort;
  for (;;) {
    appPort = await listen(app);
    try {
      await listen(sandbox, appPort + 1);
      break;
    } catch {
      await new Promise((resolve) => app.close(resolve));
    }
  }
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const sandboxOrigin = `http://127.0.0.1:${appPort + 1}`;
  const { code } = store.createPairingCode("phone");
  const paired = await request(appOrigin, "/__auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin },
    body: JSON.stringify({ code }),
  });
  const cookie = paired.headers["set-cookie"][0].split(";")[0];
  return {
    store,
    gate,
    reached,
    appOrigin,
    sandboxOrigin,
    cookie,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      for (const server of [app, sandbox]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

function request(base, pathname, { method = "GET", headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers, agent }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function openSocket(base, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/__backend/ipc`, { headers });
    ws.once("message", () => resolve({ ok: true, ws }));
    ws.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.once("error", () => resolve({ ok: false, status: 0 }));
  });
}

// What a browser sends for each kind of request a page on the sandbox origin
// can make to the app (same host, next port: "same-site").
const fromSandbox = (sandboxOrigin, kind) =>
  ({
    fetch: { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", origin: sandboxOrigin },
    script: { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
    image: { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
    iframe: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
    formInFrame: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", origin: sandboxOrigin },
    formTopLevel: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", origin: sandboxOrigin },
  })[kind];

test("a page on the sandbox origin cannot use the device cookie against the app", async (t) => {
  const s = await startPair();
  t.after(() => s.close());
  const { cookie, appOrigin, sandboxOrigin } = s;

  for (const kind of ["fetch", "script", "image", "iframe"]) {
    for (const pathname of ["/", "/@fs/etc/hosts", "/assets/index.js", "/__auth/status"]) {
      const response = await request(appOrigin, pathname, { headers: { cookie, ...fromSandbox(sandboxOrigin, kind) } });
      assert.equal(response.status, 403, `${kind} ${pathname}`);
    }
  }
  const multipart = { "content-type": "multipart/form-data; boundary=x" };
  const body = '--x\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\nhi\r\n--x--\r\n';
  for (const kind of ["fetch", "formInFrame", "formTopLevel"]) {
    const upload = await request(appOrigin, "/__backend/upload", { method: "POST", headers: { cookie, ...multipart, ...fromSandbox(sandboxOrigin, kind) }, body });
    assert.equal(upload.status, 403, `upload via ${kind}`);
  }
  // Without fetch metadata (an older browser), the Origin alone refuses writes.
  const bareUpload = await request(appOrigin, "/__backend/upload", { method: "POST", headers: { cookie, ...multipart, origin: sandboxOrigin }, body });
  assert.equal(bareUpload.status, 403);
  const pairAttempt = await request(appOrigin, "/__auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: sandboxOrigin },
    body: JSON.stringify({ code: "AAAA-AAAA" }),
  });
  assert.equal(pairAttempt.status, 403);

  assert.deepEqual(await openSocket(appOrigin, { cookie, origin: sandboxOrigin }), { ok: false, status: 403 });
  assert.deepEqual(
    await openSocket(appOrigin, { cookie, origin: sandboxOrigin, "sec-fetch-site": "same-site", "sec-fetch-mode": "websocket" }),
    { ok: false, status: 403 },
  );
  // Behind tailscale serve: same idea with https and the proxy's headers.
  assert.deepEqual(
    await openSocket(appOrigin, {
      cookie,
      origin: "https://mini.example.ts.net:8201",
      "x-forwarded-host": "mini.example.ts.net:8200",
      "x-forwarded-proto": "https",
    }),
    { ok: false, status: 403 },
  );

  assert.deepEqual(s.reached.app, [], "nothing from the sandbox origin reached the app");
  const framing = await request(appOrigin, "/", { headers: { cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  assert.match(framing.headers["content-security-policy"], /frame-ancestors 'self'/);
  assert.equal(framing.headers["x-frame-options"], "SAMEORIGIN");
});

test("the sandbox answers only paired devices, and only as an iframe of the app", async (t) => {
  const s = await startPair();
  t.after(() => s.close());
  const { cookie, sandboxOrigin } = s;
  const asFrame = { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
  const ownAsset = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "script" };

  // Unpaired: nothing, in any form.
  for (const headers of [asFrame, ownAsset, {}]) {
    for (const pathname of ["/", "/?app=skybridge", "/mcp-app.html", "/assets/main.js"]) {
      assert.equal((await request(sandboxOrigin, pathname, { headers })).status, 401, `${pathname} ${JSON.stringify(headers)}`);
    }
  }
  // Paired: the app framing the shell, and the shell loading its own files.
  assert.equal((await request(sandboxOrigin, "/?app=skybridge", { headers: { cookie, ...asFrame } })).status, 200);
  assert.equal((await request(sandboxOrigin, "/assets/main.js", { headers: { cookie, ...ownAsset } })).status, 200);
  // Paired, but never as a top-level page, from another site, or as a
  // subresource of another page on this host.
  const refused = {
    "typed or bookmarked": { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    "link from the app": { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    "same-origin top-level": { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    "popup from another site": { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    "framed by another site": { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
    "script tag on the app": { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
    "fetch from the app": { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
  };
  for (const [name, headers] of Object.entries(refused)) {
    assert.equal((await request(sandboxOrigin, "/?app=skybridge", { headers: { cookie, ...headers } })).status, 403, name);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal((await request(sandboxOrigin, "/", { method, headers: { cookie, ...asFrame } })).status, 405, method);
  }
  assert.deepEqual(s.reached.sandbox, ["GET /?app=skybridge", "GET /assets/main.js"]);
});

test("revoking a device also cuts its open sandbox connections", async (t) => {
  const s = await startPair();
  t.after(() => s.close());
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const headers = { cookie: s.cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "script" };
  assert.equal((await request(s.sandboxOrigin, "/assets/a.js", { headers, agent })).status, 200);
  const socket = Object.values(agent.freeSockets)[0]?.[0];
  assert.ok(socket, "a kept-alive connection to the sandbox");
  const closed = new Promise((resolve) => socket.once("close", resolve));
  s.store.revoke("phone");
  s.store.refresh();
  s.gate.dropRevokedConnections();
  await closed;
  assert.equal((await request(s.sandboxOrigin, "/assets/a.js", { headers })).status, 401);
});
