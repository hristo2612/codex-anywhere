# codex-anywhere

codex desktop on your phone and in any browser, served from a mac you control.
a fork of [0xcaff/codex-web](https://github.com/0xcaff/codex-web), tuned for
phones and slow connections, with a native iphone app.

the backend stays on your machine, where your files, credentials and tools
already live. agents keep running after you close the tab or the app, and you
can pick them up again from any device on your network.

## what this fork adds

- **iphone app** (`ios/`): a native shell around the web ui. voice mode keeps
  working with the screen locked, music from other apps keeps playing and is
  ducked while either side talks, and the app reopens the chat you were last
  in. see [docs/codex-anywhere/ios-app.md](docs/codex-anywhere/ios-app.md).
- **fast loads over slow links**: the desktop app pulls ~20 MB of feature-flag
  data on every load. the server now sends only what changed since the
  device's last copy, splits large messages into chunks and compresses the
  socket, so a warm load moves ~2 MB. see
  [docs/codex-anywhere/performance.md](docs/codex-anywhere/performance.md).
- **work keeps running**: closing a tab or the app never stops a turn, and each
  tab or device reuses one server-side session.
- **phone layout**: edge-to-edge chat that respects the notch and home bar, a
  sidebar that scrolls (a finger never starts a drag), menus that stay open
  on tap.
- **launch agent on macos**: starts at login, restarts after crashes, runs one
  server at a time, and caps its log at ~40 MB.

## setup on a mac

you need node 22 or newer, git, and a current codex cli (0.158 or newer) on
your `PATH`, signed in on the mac:

```bash
codex login --device-auth
```

then build and start the server:

```bash
git clone https://github.com/hristo2612/codex-anywhere
cd codex-anywhere
npm install                  # downloads codex desktop, applies the patches, builds
./scripts/install-launchd    # serves 127.0.0.1:8200 and keeps it running
```

then pair each device you will use (see [devices](#devices) below):

```bash
node scripts/pair.mjs --name iphone
```

open <http://127.0.0.1:8200> and enter the code. `./scripts/serve` restarts
the server; the log is in `~/Library/Logs/codex-anywhere/`.

to use it from your phone, put the port on your tailnet (tailnet only, never
funnel; see security below):

```bash
tailscale serve --bg --https=8200 http://127.0.0.1:8200
```

then open `https://<your-mac>.<your-tailnet>.ts.net:8200`, or build the iphone
app with that address.

plugin pages (mcp apps): sidebar pages, thread panels and inline widgets from
local plugins render in an iframe on our own copy of the mcp app sandbox
shell, served on the next port (`PORT+1`, so 8201). put that port on the
tailnet too, or the pages stay blank on the phone:

```bash
tailscale serve --bg --https=8201 http://127.0.0.1:8201
```

the shell is downloaded once by `npm install` (`scripts/mirror_mcp_sandbox.mjs`);
rerun that script after an upgrade. `/app/<server>/<tool>` deep-links a
plugin's sidebar page.

the sandbox port sits behind the same device gate as the app: it answers
paired devices only, and only as an iframe of the app (never as a page of
its own, never to another site). a plugin page runs someone else's code on
that origin, so the app refuses everything from it except plain page loads,
and the iphone app's native handlers (microphone, logs) answer only the
app's main frame. iphone app builds from before that check keep plugin
pages off (they render blank) until the app is rebuilt.

all plugin pages share that one origin, so they can reach each other's
storage and open pages: install only plugins you trust. a plugin page can
also set cookies for the host (cookies ignore ports); the server accepts
large cookie headers and the device cookie has high priority, so this
cannot lock a device out, but a hostname of its own for codex-anywhere (see
devices) is the clean fix for this too.

settings are optional; set them when you run `./scripts/install-launchd`,
which writes them into the launch agent (run it again to change them):

| variable | default | purpose |
|---|---|---|
| `PORT` | `8200` | port the launch agent serves |
| `CODEX_CLI_PATH` | a cli in `bin/codex-cli`, else `codex` on `PATH` | codex binary for the app-server |
| `CODEX_ANYWHERE_LOG_MAX_BYTES` | 20 MB | log size before it rotates to `server.log.1` |
| `CODEX_ANYWHERE_DURABLE_HOST` | off | `1` connects the cloud "durable thread" host, for accounts that have it |
| `CODEX_ANYWHERE_LABEL` | `local.codex-anywhere` | launchd label used by `install-launchd` and `serve` |
| `CODEX_ANYWHERE_ALLOWED_ORIGINS` | none | extra exact origins (comma-separated) allowed for sockets and uploads, for a proxy that rewrites `Host` without setting `X-Forwarded-Host` |
| `CODEX_ANYWHERE_HTTPS` | off | `1` says clients always arrive over HTTPS, for a TLS proxy that sets no `X-Forwarded-Proto` (Secure cookie; only https origins pass) |
| `CODEX_ANYWHERE_STATE_DIR` | `~/.codex-anywhere` | where `devices.json` lives (the server and the CLIs must agree) |

other platforms: the server runs anywhere node and the codex cli run (see
upstream for linux and nix); the launch agent and the iphone app are macos and
ios only.

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-anywhere doesn’t interrupt the codex process executing commands.

it's possible to hook codex-anywhere up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-anywhere` with the proxy helper:

```bash
nix shell github:hristo2612/codex-anywhere github:hristo2612/codex-anywhere#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-anywhere
'
```

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use; when run directly in a terminal it will wait for protocol input
rather than opening an interactive prompt.

## devices

every request and socket needs a paired device, including requests from
`127.0.0.1`: a proxy such as `tailscale serve` connects from loopback too, so
the address proves nothing. pairing works the same behind any proxy or mesh.

- `node scripts/pair.mjs --name <device>` prints a code that works once, for
  10 minutes (`--minutes` up to 60). open the server on the device and enter
  it; the device gets a cookie (HttpOnly, SameSite=Strict, Secure over HTTPS)
  that lasts 400 days and renews on every page load. a link of the form
  `https://<server>/__auth/pair#code=XXXX-XXXX` fills in and submits the code
  (`--url <server>` prints it).
- the same code also comes in a long form (24 characters). it is never
  rate-limited, so paste it if someone floods the pairing page with wrong
  codes.
- safari, a home-screen web app and the iphone app each keep their own
  cookies, so pair each one.
- `node scripts/devices.mjs list` shows devices and when each was last seen;
  `node scripts/devices.mjs revoke <id or name>` (or `--all`) revokes. a
  running server closes the device's sockets within a second and the page
  falls back to the pairing screen.
- only hashes are stored, in `~/.codex-anywhere/devices.json` (mode 600). if
  that file is unreadable, malformed or writable by others, every device is
  refused until it is fixed; deleting it revokes every device.
- wrong codes are rate-limited for the whole server (5 a minute, 30 an hour;
  past that, pending codes are burned). a new code starts a fresh budget.
  short codes are stored as salted scrypt hashes; long codes and device
  tokens as SHA-256.
- sockets and uploads must come from the server's own origin, scheme and
  port included (cross-site WebSocket hijacking), and other sites, including
  other ports of the same host, cannot frame the app or load its files.
- give codex-anywhere a hostname of its own. browsers send a host's cookies
  to every port of that host, so any other service on the same hostname
  receives the device cookie when you visit it.
- local files under `/@fs/` (the app's images) are served with a sandbox
  csp: an html or svg file opened there never runs as part of the app. the
  pairing page only ever returns to the app's start page or a thread, so a
  link from another site cannot carry the device cookie anywhere else.
- behind a proxy, the proxy must set (not append to) `X-Forwarded-Host` and
  `X-Forwarded-Proto`; `tailscale serve` does.
- local test tools (`test/measure-load.mjs`, `test/capture-big-frames.mjs`,
  `ios/tests/rtc-bridge-contract.mjs`) use a token file:
  `node scripts/devices.mjs local-token` pairs a `local-tools` device for 12
  hours (`--hours`) and writes its token to `~/.codex-anywhere/local-token`
  (mode 600).
- `npm run dev:browser` proxies to the server from another port: start the
  server with `CODEX_ANYWHERE_ALLOWED_ORIGINS=http://127.0.0.1:4173` and pair
  the browser at the server's own port first (the cookie covers both ports).

## security

treat anyone who can use a paired device, or who can run code as the user
running the server, as someone who can operate codex on the host machine as
that user. keep it off the public internet anyway (tailnet only, never
funnel): the pairing page and the gate are the only things between the
internet and a shell.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-anywhere`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## Based on codex-web by Martin Charles (https://github.com/0xcaff/codex-web)

codex-anywhere is a fork of [codex-web](https://github.com/0xcaff/codex-web)
by Martin Charles ([@0xcaff](https://x.com/0xcaff)), which does the hard
part: running the codex desktop app headless and serving it to a browser.
codex-web declares the MIT license (in its `package.json`), and this fork
is MIT licensed too (see [LICENSE](LICENSE)).

what this fork adds on top:

- **phone layout**: edge-to-edge chat within the safe areas, a sidebar that
  scrolls, menus that stay open on tap.
- **iphone app** (`ios/`): a native shell with voice mode that keeps working
  with the screen locked and mixes with other apps' audio.
- **device pairing**: every request and socket needs a paired device; codes
  from `scripts/pair.mjs`, revocation from `scripts/devices.mjs`.
- **plugin pages**: sidebar pages, panels and inline widgets from local
  plugins (mcp apps), rendered from a local copy of the sandbox shell on a
  separate, gated origin.
- **load performance**: deltas for large socket frames, chunking and
  compression, so a warm load over a slow link moves ~2 MB instead of ~20 MB.
- **sessions that outlive the tab**, one server per machine, and a macos
  launch agent with log rotation.

upgrades to new codex desktop versions follow [UPGRADING.md](UPGRADING.md).

codex and chatgpt are trademarks of openai. this project is not affiliated with
or endorsed by openai.
