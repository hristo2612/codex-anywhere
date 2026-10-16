# codex-anywhere: load time and backend lifecycle

How a page gets from URL to a rendered chat, what was slow, and the rules that
keep it fast. Measured 2026-09-30 on an M-series Mac mini host, through a Tailscale URL.

## The path

1. `index.html` (no-cache) → `assets/preload.js` (our shim, no-cache) and the
   app's module graph (~250 files, `immutable` except patched ones).
2. The shim opens `wss://…/__backend/ipc`; the server creates a session (one
   app window in the Codex main process) and says hello.
3. The renderer boots: app host services, persisted atoms, statsig, config
   reads, thread list, then the route (home or `/thread/<id>`).

## What was slow and what fixed it

| Problem | Fix | Where |
|---|---|---|
| Every page load moved ~20 MB of statsig JSON down (the `statsig_evaluations` shared object twice, the `/wham/statsig/bootstrap` body as base64) and uploaded the 5 MB object back. Over the phone's Tailscale DERP relay (~95 ms RTT) this dominated. | Big frames (>128 KB) travel as rsync-style deltas against the copy the other side already holds. The browser keeps its copies in IndexedDB and declares them at connect. Next load: under 1 KB each way. | `src/server/frame-delta*.ts`, `src/browser/frame-delta.ts` |
| Statsig writes its maps in random key order on every fetch, so byte deltas didn't match. | The fetch stub key-sorts the bootstrap JSON (same meaning; the app only `JSON.parse`s it). A new fetch then differs by ~5 KB. | `canonicalStatsigResponse` in `src/server/electron/index.ts` |
| A multi-second frame on a slow link made the 3 s heartbeat declare the socket dead. The page reconnected, the session replayed the same frame, and it never finished loading. | Frames over 128 KB go out as 64 KB chunks. The heartbeat counts any traffic since the ping, or an upload still draining, as alive. | `sendRaw` in `src/server/main.ts`, `checkConnection` and the chunk reassembly in `src/browser/shim.ts` |
| Uncompressed socket | `permessage-deflate` (level 1) | `main.ts` |
| Each page load left a server window behind for 10 min, and every window receives every engine event. | One detached window per device (the `client` id in localStorage), at most 6 detached overall, 4 h TTL so a suspended phone resumes instead of rebooting, and a 30 s grace after `bye`. | `main.ts` |
| Returning after an absence waited out a 3 s ping on a dead socket. | Hidden for more than 5 s means reconnect immediately. | `shim.ts` |

The page only gets deltas and chunks when it asks (`fd=1`, `ck=1` on the
socket URL), so an older page never receives a frame it can't read. Kill
switches: `CODEX_WEB_NO_FRAME_DELTA`, `CODEX_WEB_NO_STATSIG_CANON`. Set
`CODEX_WEB_DEBUG_DELTA` to log delta sizes.

Measured, desktop (headless Chrome on the host):
- Socket traffic per warm load: 14.5 MB → ~1.4 MB down, 7.5 MB → ~0.9 MB up, before compression.
- Time to the app shell stays ~2–3 s. That time is the renderer's own JS start-up and rendering.

Phone-like (Chrome throttling 95 ms / 10 Mbps):
- Before: warm loads never rendered (the heartbeat loop).
- After: 4.8–6.0 s to the composer.

## Snapshots: tried and removed

On 2026-09-30 a stored picture of the last screen was painted at ~33 ms (web)
or ~0.3 s (iOS) while the app booted, then handed over to the live app. It was
removed the same day: for the ~2 s boot it looked interactive but wasn't, and
an honest loading indicator is better. The shim deletes any snapshots it left
in localStorage (`codex-web:instant-paint:*`). The iOS app now shows a native
spinner until the page renders and still reopens the last thread. The real
boot (the app's own JS, ~2 s on the host Mac) is the floor without changing
OpenAI's code.

## Keeping work alive

Closing a tab, leaving the page or quitting the phone app never stops running work:
- Turns run in the engine (app-server), not in the page.
- No window-close path interrupts a turn or unsubscribes a thread.

Verified 2026-09-30: a turn running `sleep 40; date` finished 40 s after its only tab was closed.

What does stop local turns is restarting this server: the "local" host's app-server is its child. So before `scripts/serve`:
- check that no rollout under `~/.codex/sessions` was written in the last few minutes;
- check that the app-server's CPU is idle.

Voice runs in the page and ends with it. `ios/tests/rtc-bridge-contract.mjs` must still pass after transport changes (9/9 on 2026-09-30).

## One backend

- `~/.codex-anywhere/server.lock` refuses a second server on any port.
- `scripts/serve` only restarts the LaunchAgent.
- The ChatGPT desktop app, when running on the same Mac, is a separate backend with its own local app-server.

## Deploying

- **Browser-only change** (shim, frame-delta browser side): `npm run build:browser && node scripts/optimize_webview.mjs --only assets/preload.js,assets/preload.js.map,index.html`. No restart; pages pick it up on their next load.
- **iOS app:** from `ios/`, `xcodebuild -project CodexAnywhere.xcodeproj -scheme CodexAnywhere -destination generic/platform=iOS -derivedDataPath build -allowProvisioningUpdates build`, then `xcrun devicectl device install app --device <id from xcrun devicectl list devices> build/Build/Products/Debug-iphoneos/CodexAnywhere.app`. The phone must be unlocked and on the same network, or cabled.
- **Server change:** `npm run build:server`, check for running turns (above), then `scripts/serve`.
- **Full webview rebuild:** `npm run build:webview-dist`. It builds next to the served copy and swaps it in, so open tabs never see missing files.

## Measuring

Chrome's network emulation delays every WebSocket frame one by one, so a throttled run takes minutes to boot the app. Model phone RTT on the HTML path instead.

The load harness is in `test/`, next to the frame-delta tests. Probes must navigate by URL only: clicking a sidebar row can land on its hover archive button, and the UI is connected to real data.
