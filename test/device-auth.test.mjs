// Device gate: store, rate limit, HTTP and WebSocket rules, revocation.
//   npm run build:server && node --test test/device-auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const { DeviceStore, DeviceGate, AttemptLimiter, refuseUpgrade, normalizeCode, PLAIN_COOKIE, SECURE_COOKIE, PAIRING_RETURN_PATH } = require("../src/server/device-auth.js");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-anywhere-auth-test-"));
const mode = (file) => fs.statSync(file).mode & 0o777;

test("pairing codes are single use, expire, and only hashes are stored", () => {
  const dir = tempDir();
  const store = new DeviceStore(dir);
  const now = Date.now();
  const { code, name } = store.createPairingCode("iPhone <script>", 10 * 60_000, now);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(name, "iPhone script");
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(store.file), 0o600);

  const paired = store.redeemPairingCode(code.toLowerCase().replace("-", " "), "UA", now + 1000);
  assert.ok(paired, "a fresh code pairs");
  assert.match(paired.token, /^cad1_[A-Za-z0-9_-]{43}$/);
  assert.equal(store.redeemPairingCode(code, "", now + 2000), null, "a code works once");
  assert.equal(store.authenticate(paired.token)?.id, paired.device.id);
  assert.equal(store.authenticate(`${paired.token}x`), null);
  assert.equal(store.authenticate(""), null);

  const raw = fs.readFileSync(store.file, "utf8");
  assert.ok(!raw.includes(paired.token), "the token is not stored");
  assert.ok(!raw.includes(code.replace("-", "")), "the code is not stored");

  const late = store.createPairingCode("late", 60_000, now);
  assert.equal(store.redeemPairingCode(late.code, "", now + 61_000), null, "an expired code fails");
  assert.equal(store.pendingCodes(now + 61_000).length, 0);
});

test("code normalization maps look-alike characters", () => {
  assert.equal(normalizeCode(" ab0o-1ilz "), "AB00111Z");
});

test("revoking by id or unique name; ambiguous names refuse", () => {
  const store = new DeviceStore(tempDir());
  const pair = (name) => store.redeemPairingCode(store.createPairingCode(name).code);
  const a = pair("phone");
  const b = pair("phone");
  const c = pair("laptop");
  assert.throws(() => store.revoke("phone"), /2 devices are named/);
  assert.deepEqual(store.revoke(a.device.id).map((d) => d.id), [a.device.id]);
  assert.equal(store.authenticate(a.token), null);
  assert.ok(store.authenticate(b.token));
  assert.equal(store.revoke("laptop")[0].id, c.device.id);
  assert.equal(store.revoke("nothing").length, 0);
  store.revokeAll();
  assert.equal(store.authenticate(b.token), null);
});

test("a second store instance (the CLI) sees changes after refresh", () => {
  const dir = tempDir();
  const server = new DeviceStore(dir);
  const cli = new DeviceStore(dir);
  server.refresh();
  const paired = server.redeemPairingCode(cli.createPairingCode("ipad").code);
  assert.ok(paired, "the server redeems a code the CLI made");
  cli.revoke("ipad");
  assert.ok(server.authenticate(paired.token), "still cached until refresh");
  assert.equal(server.refresh(), true);
  assert.equal(server.authenticate(paired.token), null);
  assert.equal(server.isActive(paired.device.id), false);
});

test("an unusable devices file fails closed and is never overwritten", () => {
  const dir = tempDir();
  const store = new DeviceStore(dir);
  const paired = store.redeemPairingCode(store.createPairingCode("x").code);
  fs.writeFileSync(store.file, "{ not json", { mode: 0o600 });
  store.refresh();
  assert.ok(store.error);
  assert.equal(store.authenticate(paired.token), null);
  assert.throws(() => store.createPairingCode("y"), /fix or remove it first/);
  assert.equal(fs.readFileSync(store.file, "utf8"), "{ not json");

  // A file others can read is tightened to 600 on load.
  const other = new DeviceStore(tempDir());
  const again = other.redeemPairingCode(other.createPairingCode("z").code);
  fs.chmodSync(other.file, 0o644);
  const fresh = new DeviceStore(other.dir);
  fresh.refresh();
  assert.equal(mode(other.file), 0o600);
  assert.ok(fresh.authenticate(again.token));

  // A symlinked devices file is refused.
  const linked = new DeviceStore(tempDir());
  fs.mkdirSync(linked.dir, { recursive: true });
  fs.symlinkSync(other.file, linked.file);
  linked.refresh();
  assert.match(linked.error, /not a regular file/);
  assert.equal(linked.authenticate(again.token), null);

  // Deleting the file revokes everyone.
  fs.rmSync(other.file);
  fresh.refresh();
  assert.equal(fresh.authenticate(again.token), null);
});

test("limiter: 5 failures a minute, 30 an hour", () => {
  const limiter = new AttemptLimiter();
  let now = 1_000_000;
  for (let i = 0; i < 5; i += 1) limiter.fail(now);
  assert.ok(limiter.retryAfter(now) > 0);
  now += 61_000;
  assert.equal(limiter.retryAfter(now), 0);
  let exhausted = false;
  for (let i = 0; i < 25; i += 1) {
    now += 13_000;
    exhausted = limiter.fail(now) || exhausted;
  }
  assert.equal(exhausted, true);
  assert.ok(limiter.retryAfter(now + 120_000) > 0, "hourly budget still spent");
});

// A server wired like src/server/main.ts: the gate in front of every request
// and upgrade, and a revocation sweep over open sockets.
async function startGatedServer() {
  const store = new DeviceStore(tempDir());
  store.refresh();
  const publicDir = tempDir();
  fs.writeFileSync(path.join(publicDir, "manifest.json"), '{"name":"x"}');
  const gate = new DeviceGate({
    store,
    publicFiles: { "/manifest.json": { file: path.join(publicDir, "manifest.json"), contentType: "application/manifest+json" } },
    log: () => {},
  });
  const reached = [];
  const server = http.createServer((req, res) => {
    if (gate.handleRequest(req, res)) return;
    reached.push(req.url);
    res.end("app");
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map();
  server.on("upgrade", (req, socket, head) => {
    const decision = gate.authorizeUpgrade(req);
    if (!decision.ok) return refuseUpgrade(socket, decision.status);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, decision.device.id);
      ws.send("hello");
    });
  });
  let generation = store.generation;
  const sweep = setInterval(() => {
    store.refresh();
    if (store.generation === generation) return;
    generation = store.generation;
    for (const [ws, deviceId] of sockets) if (!store.isActive(deviceId)) ws.close(4401, "Device revoked");
    gate.dropRevokedConnections();
  }, 50);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    store,
    gate,
    base,
    origin: base,
    reached,
    async close() {
      clearInterval(sweep);
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function request(base, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const cookieFrom = (response) => response.headers["set-cookie"]?.[0]?.split(";")[0];

async function pair(server, extraHeaders = {}) {
  const { code } = server.store.createPairingCode("test");
  const origin = extraHeaders["x-forwarded-proto"] === "https" ? server.origin.replace("http:", "https:") : server.origin;
  const response = await request(server.base, "/__auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...extraHeaders },
    body: JSON.stringify({ code }),
  });
  return { response, cookie: cookieFrom(response) };
}

function openSocket(base, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/__backend/ipc`, { headers });
    ws.once("message", () => resolve({ ok: true, ws }));
    ws.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.once("error", () => resolve({ ok: false, status: 0 }));
  });
}

test("unpaired requests never reach the app, from loopback or a proxy", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const page = await request(server.base, "/", { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  assert.equal(page.status, 401);
  assert.match(page.text, /Pair this device/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");

  const proxied = { "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https", "tailscale-user-login": "someone@example.com" };
  for (const pathname of ["/assets/index.js", "/@fs/etc/hosts", "/thread/abc", "/__auth/pair/../../@fs/etc/hosts"]) {
    const response = await request(server.base, pathname, { headers: proxied });
    assert.equal(response.status, 401, pathname);
  }
  const upload = await request(server.base, "/__backend/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "--x--" });
  assert.equal(upload.status, 401);
  assert.equal((await request(server.base, "/manifest.json")).status, 200, "the manifest is public");
  assert.equal((await request(server.base, "/__auth/status")).status, 401);
  assert.deepEqual(server.reached, []);

  const socket = await openSocket(server.base, { origin: server.origin });
  assert.deepEqual(socket, { ok: false, status: 401 });
});

test("pairing sets an HttpOnly SameSite=Strict cookie; Secure behind HTTPS", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const plain = await pair(server);
  assert.equal(plain.response.status, 200);
  const setCookie = plain.response.headers["set-cookie"][0];
  assert.ok(setCookie.startsWith(`${PLAIN_COOKIE}=cad1_`));
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Path=\//);
  assert.doesNotMatch(setCookie, /Secure/);

  const secure = await pair(server, { "x-forwarded-proto": "https" });
  const secureCookie = secure.response.headers["set-cookie"][0];
  assert.ok(secureCookie.startsWith(`${SECURE_COOKIE}=cad1_`));
  assert.match(secureCookie, /; Secure/);

  for (const cookie of [plain.cookie, secure.cookie]) {
    const page = await request(server.base, "/thread/abc", { headers: { cookie, "sec-fetch-mode": "navigate" } });
    assert.equal(page.status, 200);
    assert.equal(page.text, "app");
    assert.ok(page.headers["set-cookie"][0].startsWith(cookie), "page loads renew the cookie");
  }
  const status = await request(server.base, "/__auth/status", { headers: { cookie: plain.cookie } });
  assert.equal(status.status, 200);
});

test("pairing refuses missing or foreign origins, non-JSON and wrong codes, and rate-limits", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { code } = server.store.createPairingCode("victim");
  const post = (headers, body = JSON.stringify({ code })) =>
    request(server.base, "/__auth/pair", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.equal((await post({})).status, 403, "no Origin");
  assert.equal((await post({ origin: "https://evil.example" })).status, 403);
  const otherPort = server.origin.replace(/:\d+$/, ":7777");
  assert.equal((await post({ origin: otherPort })).status, 403, "another port of the same host");
  assert.equal((await post({ origin: server.origin, "content-type": "text/plain" })).status, 415);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await post({ origin: server.origin }, JSON.stringify({ code: "AAAA-AAAA" }))).status, 401);
  }
  const limited = await post({ origin: server.origin });
  assert.equal(limited.status, 429, "the right code is refused while rate-limited");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(server.store.devices().length, 0);
});

test("other origins cannot use a paired cookie for subresources, writes or sockets", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { cookie } = await pair(server);
  const sameSite = await request(server.base, "/@fs/etc/hosts", {
    headers: { cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
  });
  assert.equal(sameSite.status, 403);
  const framed = await request(server.base, "/", {
    headers: { cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
  });
  assert.equal(framed.status, 403);
  const write = await request(server.base, "/__backend/upload", { method: "POST", headers: { cookie, origin: "https://evil.example" } });
  assert.equal(write.status, 403);
  const link = await request(server.base, "/", {
    headers: { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.equal(link.status, 200, "a top-level link from elsewhere still opens the app");

  const otherPort = server.origin.replace(/:\d+$/, ":7777");
  assert.deepEqual(await openSocket(server.base, { cookie }), { ok: false, status: 403 }, "no Origin");
  assert.deepEqual(await openSocket(server.base, { cookie, origin: otherPort }), { ok: false, status: 403 });
  assert.deepEqual(await openSocket(server.base, { cookie, origin: "null" }), { ok: false, status: 403 });
  const proxied = await openSocket(server.base, {
    cookie,
    origin: "https://mini.example.ts.net:8200",
    "x-forwarded-host": "mini.example.ts.net:8200",
    "x-forwarded-proto": "https",
  });
  assert.equal(proxied.ok, true, "a proxy's X-Forwarded-Host counts as this server");
  proxied.ws.close();
  const sameOrigin = await openSocket(server.base, { cookie, origin: server.origin });
  assert.equal(sameOrigin.ok, true);
  sameOrigin.ws.close();
});

test("revoking a device closes its socket with 4401 and refuses its next request", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { cookie } = await pair(server);
  const opened = await openSocket(server.base, { cookie, origin: server.origin });
  assert.equal(opened.ok, true);
  const closed = new Promise((resolve) => opened.ws.once("close", (code) => resolve(code)));
  const cli = new DeviceStore(server.store.dir);
  cli.refresh();
  assert.equal(cli.revoke("test").length, 1);
  assert.equal(await closed, 4401);
  assert.equal((await request(server.base, "/", { headers: { cookie } })).status, 401);
  assert.deepEqual(await openSocket(server.base, { cookie, origin: server.origin }), { ok: false, status: 401 });
});

test("the Origin's scheme must match how the client reached the server", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { cookie } = await pair(server);
  const behindProxy = { cookie, "x-forwarded-host": "mini.example.ts.net", "x-forwarded-proto": "https" };
  assert.deepEqual(await openSocket(server.base, { ...behindProxy, origin: "http://mini.example.ts.net" }), { ok: false, status: 403 }, "http page, https server on the default port");
  const ok = await openSocket(server.base, { ...behindProxy, origin: "https://mini.example.ts.net" });
  assert.equal(ok.ok, true);
  ok.ws.close();
  assert.deepEqual(await openSocket(server.base, { cookie, origin: server.origin.replace("http:", "https:") }), { ok: false, status: 403 }, "https Origin on a plain-HTTP connection");
  const write = await request(server.base, "/__backend/upload", { method: "POST", headers: { ...behindProxy, origin: "http://mini.example.ts.net" } });
  assert.equal(write.status, 403);
});

test("socket upgrades with cross-site or same-site fetch metadata are refused", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { cookie } = await pair(server);
  for (const site of ["cross-site", "same-site", "none"]) {
    assert.deepEqual(await openSocket(server.base, { cookie, origin: server.origin, "sec-fetch-site": site }), { ok: false, status: 403 }, site);
  }
  const ok = await openSocket(server.base, { cookie, origin: server.origin, "sec-fetch-site": "same-origin" });
  assert.equal(ok.ok, true);
  ok.ws.close();
});

test("renewing over HTTPS moves a plain cookie to the Secure name and drops the plain copy", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { cookie } = await pair(server);
  const page = await request(server.base, "/", { headers: { cookie, "sec-fetch-mode": "navigate", "x-forwarded-proto": "https" } });
  assert.equal(page.status, 200);
  const [secure, cleared] = page.headers["set-cookie"];
  assert.ok(secure.startsWith(`${SECURE_COOKIE}=cad1_`) && secure.includes("; Secure"));
  assert.match(cleared, new RegExp(`^${PLAIN_COOKIE}=; .*Max-Age=0`));
});

test("a new code gives the owner a fresh attempt budget", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  server.store.createPairingCode("first");
  const post = (code) =>
    request(server.base, "/__auth/pair", { method: "POST", headers: { "content-type": "application/json", origin: server.origin }, body: JSON.stringify({ code }) });
  for (let i = 0; i < 5; i += 1) assert.equal((await post("AAAA-AAAA")).status, 401);
  assert.equal((await post("AAAA-AAAA")).status, 429);
  const { code } = server.store.createPairingCode("owner", 10 * 60_000, Date.now() + 1000);
  assert.equal((await post(code)).status, 200, "the fresh code works despite the earlier failures");
});

test("revocation also cuts the device's open HTTP connections", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { cookie } = await pair(server);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const socket = await new Promise((resolve, reject) => {
    const req = http.get(`${server.base}/`, { agent, headers: { cookie } }, (res) => {
      res.resume();
      res.on("end", () => resolve(req.socket));
    });
    req.on("error", reject);
  });
  assert.equal(socket.destroyed, false);
  const closed = new Promise((resolve) => socket.once("close", () => resolve(true)));
  const cli = new DeviceStore(server.store.dir);
  cli.refresh();
  cli.revoke("test");
  assert.equal(await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 2000))]), true);
});

test("store: writable by others fails closed; recovers once fixed; local devices expire", () => {
  const store = new DeviceStore(tempDir());
  const paired = store.redeemPairingCode(store.createPairingCode("x").code);
  assert.ok(store.authenticate(paired.token));
  fs.chmodSync(store.file, 0o622);
  store.refresh();
  assert.match(store.error, /writable by others/);
  assert.equal(store.authenticate(paired.token), null);
  assert.equal(mode(store.file), 0o622, "not silently fixed");
  fs.chmodSync(store.file, 0o600);
  store.refresh();
  assert.equal(store.error, null, "recovers without the file changing");
  assert.ok(store.authenticate(paired.token));

  fs.chmodSync(store.dir, 0o777);
  store.refresh();
  assert.match(store.error, /writable by others/);
  fs.chmodSync(store.dir, 0o700);
  store.refresh();
  assert.equal(store.error, null);

  const now = Date.now();
  const local = store.addDevice("local-tools", 60_000, now);
  assert.ok(store.authenticate(local.token, now + 30_000));
  assert.equal(store.authenticate(local.token, now + 61_000), null);
  assert.equal(store.isActive(local.device.id, now + 61_000), false);
  const raw = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(raw.devices.find((d) => d.id === local.device.id).expiresAt, new Date(now + 60_000).toISOString());
});

test("the long form of a code skips the attempt limit, and either form spends the code", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { code, longCode } = server.store.createPairingCode("owner");
  assert.match(longCode, /^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
  const raw = fs.readFileSync(server.store.file, "utf8");
  assert.ok(!raw.includes(longCode.replaceAll("-", "")), "the long code is not stored");
  const post = (value) =>
    request(server.base, "/__auth/pair", { method: "POST", headers: { "content-type": "application/json", origin: server.origin }, body: JSON.stringify({ code: value }) });
  for (let i = 0; i < 5; i += 1) await post("AAAA-AAAA");
  assert.equal((await post(code)).status, 429, "short form is rate-limited");
  assert.equal((await post(longCode.toLowerCase())).status, 200, "long form still pairs");
  assert.equal((await post(longCode)).status, 401, "and only once");
  assert.equal(server.store.redeemPairingCode(code), null, "the short form was spent with it");
  assert.equal((await post("A".repeat(24))).status, 401, "a wrong long code fails without touching the limit");
});

test("parallel wrong attempts cannot get past the per-minute limit", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  server.store.createPairingCode("owner");
  const statuses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      request(server.base, "/__auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.origin },
        body: JSON.stringify({ code: `AAAA-AA${String(i).padStart(2, "0").replace(/\d/g, (d) => "ABCDEFGHJK"[d])}` }),
      }).then((response) => response.status),
    ),
  );
  assert.equal(statuses.filter((status) => status === 401).length, 5);
  assert.equal(statuses.filter((status) => status === 429).length, 15);
});

test("the pairing page keeps a whole long-form code from a link fragment", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const page = await request(server.base, "/__auth/pair", { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  const { longCode } = server.store.createPairingCode("long-link");
  const cut = Number(page.text.match(/hashCode = decodeURIComponent\(.*?\.slice\(0, (\d+)\)/)?.[1]);
  assert.ok(cut >= longCode.length, `fragment cut at ${cut}, long code is ${longCode.length} characters`);
  const maxlength = Number(page.text.match(/id="code"[^>]*maxlength="(\d+)"/)?.[1]);
  assert.ok(maxlength >= longCode.length, "the input takes a long code too");
});

test("pairing: the cookie has high priority, and a successful pairing clears the HTTP cache", async (t) => {
  const server = await startGatedServer();
  t.after(() => server.close());
  const { response } = await pair(server);
  assert.match(response.headers["set-cookie"][0], /; Priority=High/);
  assert.equal(response.headers["clear-site-data"], '"cache"');
  const wrong = await request(server.base, "/__auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({ code: "AAAA-AAAA" }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers["clear-site-data"], undefined);
});

test("the pairing page only returns to app routes, never to files or plugin pages", async (t) => {
  for (const ok of ["/", "/thread/01a1415a-87e6-7c61-bba4-2cc35670b79e"]) assert.ok(PAIRING_RETURN_PATH.test(ok), ok);
  for (const bad of ["/@fs/Users/x/evil.html", "/@fs/x.svg", "/app/mission-control/mission_control_open", "/share/receive", "//evil.example/", "/thread/a/b", "/thread/", "/index.html"]) {
    assert.ok(!PAIRING_RETURN_PATH.test(bad), bad);
  }
  const server = await startGatedServer();
  t.after(() => server.close());
  const page = await request(server.base, "/@fs/x/evil.html", { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  assert.equal(page.status, 401);
  assert.ok(page.text.includes(`${PAIRING_RETURN_PATH}.test(location.pathname)`), "the page uses the same allowlist");
  assert.ok(!/location\.search\)?;?\s*$/m.test(page.text.match(/const target = .*$/m)[0]), "the return drops the query");
});
