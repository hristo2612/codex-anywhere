# codex-anywhere iOS app

A sideloaded build, signed with your own Apple development team and installed
from Xcode. Not for the App Store.

## Build and install

1. Install XcodeGen (`brew install xcodegen`) and run `xcodegen generate` in
   `ios/` after changing `project.yml`.
2. Copy `ios/Config/Local.xcconfig.example` to `ios/Config/Local.xcconfig`
   (gitignored) and set your team, bundle id and server URL.
3. Open `ios/CodexAnywhere.xcodeproj`, pick your iPhone and run. Without a
   server URL the app opens Settings on first launch; a three-finger double tap
   opens them later.

## Goals

1. Open instantly and stay live: one persistent web view on the codex-anywhere
   server (e.g. its Tailscale URL), reusing the server's resumable sessions.
2. Voice mode keeps working with the screen locked or the app in the background
   (voice must be started in the foreground; an incoming phone call ends it).
3. Music from other apps keeps playing in full-quality stereo on Bluetooth
   headphones and is ducked automatically while either side speaks.

Non-goals: App Store review, push notifications, offline use, voice started from
the lock screen, controlling another app's playback directly (iOS forbids it).

## Why native

A PWA or Safari tab gets its microphone muted when hidden, and WebKit's
microphone session never mixes with other apps' audio. A WKWebView host with the
`audio` background mode keeps capture alive, but WebKit still owns a
non-mixable play-and-record session. So the voice call's media moves to native
WebRTC, where the app owns the audio session.

## Architecture

```
iPhone app (SwiftUI)
  WKWebView ── loads https://<mac>.ts.net:8200/ (codex-anywhere web UI)
    injected "rtc-bridge.js" (all frames, document start, app-only)
      main frame: window.__codexAnywhereRTC routes Swift's events
      voice window (same-origin iframe): calls Swift through the main
        frame's handler (top.webkit.messageHandlers)
      window.RTCPeerConnection  -> NativePeerConnection (messages to Swift)
      getUserMedia(audio)       -> silent stand-in stream
      navigator.audioSession    -> "ambient" (never interrupts other audio)
  FrameGuard.swift      native handlers answer only the main frame of the
                        server's origin (plugin pages run in iframes on
                        another origin)
  RTCBridge.swift       peer connections, data channels, events back to the
                        main frame's router
  VoiceAudioDevice.swift RTCAudioDevice on a VoiceProcessingIO unit:
                          playAndRecord + mixWithOthers + allowBluetoothA2DP,
                          advanced "other audio" ducking (iOS 17+)
Host Mac
  codex-anywhere server (unchanged protocol) -> Codex app-server, OpenAI
```

The web app's voice code (`webrtc-session-*.js`) uses a small WebRTC surface:
one `RTCPeerConnection`, one data channel `oai-events`, `addTrack` of the mic
stream, `createOffer` / `setLocalDescription` / `setRemoteDescription`,
`connectionState` / `iceConnectionState` events and `ontrack` for the remote
audio. The bridge implements exactly that surface. SDP negotiation still flows
through the web app and the Mac, so no server change is needed.

Mute: the page mutes by toggling `enabled` on the track it passes to `addTrack`;
the bridge wraps that property and forwards it to the native microphone.

## Audio behaviour

- Session: `.playAndRecord`, mode `.default`, options `.mixWithOthers`,
  `.allowBluetoothA2DP`, `.defaultToSpeaker`. No HFP, so Bluetooth headphones stay in stereo
  A2DP and the phone's own microphone is used.
- Voice processing (echo cancellation for our own output) through a
  VoiceProcessingIO unit, with `kAUVoiceIOProperty_OtherAudioDuckingConfiguration`
  = advanced ducking, level mid: other audio ducks while either side talks.
- Setting `ducking` in the app's settings screen picks: advanced (default),
  "pause other audio for the whole call" (non-mixable session), or off.

## Web view behaviour

- One WKWebView for the app's lifetime; the page reconnects its session itself.
- `allowsInlineMediaPlayback`, no user action required for playback,
  microphone permission granted automatically to the main frame of the
  server origin, and denied to every other frame.
- Native handlers (`codexAnywhereRTC`, `codexAnywhereLog`,
  `codexAnywhereReady`) answer only the main frame of the server's origin
  (`FrameGuard.swift`). Same-origin iframes (the voice window) post through
  the main frame's handler, which WebKit reports as the main frame; a
  cross-origin frame cannot reach `top.webkit`. A main-frame marker
  (`__codexAnywhereFrameGuard`) tells the web app plugin pages are safe here;
  older builds without it get no plugin pages.
- Popups (`window.open`, `target=_blank`) open in Safari for http(s) links
  only.
- `node ios/tests/frame-guard/run.mjs` checks all of this in real WebKit (a
  macOS WKWebView) with the app's own `FrameGuard.swift`, `rtc-bridge.js` and
  `web-log.js`.
- Web content process crash: reload.
- Server URL stored in UserDefaults; a three-finger double tap opens
  Settings to change it.

## Verification plan

1. JS bridge contract test in Chrome: a fake `webkit.messageHandlers` backed by
   a real browser RTCPeerConnection completes a voice session against the live
   server (offer/answer, data channel open, `connected` state).
2. `xcodebuild` for iphoneos succeeds with signing.
3. Run the app on a Mac ("Designed for iPad") if possible: page loads,
   voice session reaches `connected` through native WebRTC.
4. On a physical iPhone: voice with screen locked; music from another app ducks
   while either side talks and stays stereo on headphones; reopen is instant.

## Plan

1. Rename codex-web to codex-anywhere.
2. `ios/` XcodeGen project: SwiftUI shell, persistent WKWebView, Info.plist
   (`audio` background mode, mic usage string), settings for server URL.
3. `rtc-bridge.js` + `RTCBridge.swift` (stasel/WebRTC 153 via SwiftPM).
4. `VoiceAudioDevice.swift` with VPIO + ducking; session configuration.
5. Verify steps 1–3 above; fix; then test on a device.
