// codex-anywhere iOS: native WebRTC bridge for the realtime voice window.
//
// Injected at document start into every frame, active only inside the app and
// only in the hidden voice window (codexWebWindow=… from the server). The page
// keeps negotiating the call itself; media runs natively so the app can own the
// iOS audio session (mix with other apps' music, duck while talking, keep
// running with the screen locked).
//
// Swift answers only the main frame of the server's origin (FrameGuard.swift),
// so plugin pages, which run in iframes on another origin, never reach the
// microphone. The voice window is a same-origin iframe: it posts through the
// main frame's handler, and Swift's events arrive at the main frame's router
// (window.__codexAnywhereRTC), which hands each one to the frame that owns the
// peer connection.
(() => {
  let main;
  try {
    main = window.top;
    // Reading a cross-origin frame's location throws: such frames get nothing.
    if (main !== window && main.location.origin !== window.location.origin) return;
  } catch {
    return;
  }
  const handler = main.webkit?.messageHandlers?.codexAnywhereRTC;
  if (!handler) return;

  if (window === main) {
    if (window.__codexAnywhereRTC) return;
    const owners = new Map(); // pcId -> the owning frame's dispatcher
    Object.defineProperty(window, "__codexAnywhereRTC", {
      value: Object.freeze({
        dispatch(event) {
          const owner = owners.get(event?.pcId);
          if (!owner) return;
          try {
            owner.dispatch(event);
          } catch (error) {
            // The owning frame is gone (the voice window was closed).
            owners.delete(event.pcId);
          }
        },
        register(pcId, owner) {
          owners.set(pcId, owner);
        },
        unregister(pcId) {
          owners.delete(pcId);
        },
      }),
    });
    return;
  }

  if (window.__codexAnywhereRTCFrame) return;
  if (!new URLSearchParams(location.search).has("codexWebWindow")) return;
  const router = main.__codexAnywhereRTC;
  if (!router) return;

  const call = (message) => handler.postMessage(message);
  // Fire-and-forget messages: a late one for a peer Swift already dropped must
  // not surface as an unhandled rejection in the page.
  const post = (message) => {
    new Promise((resolve) => resolve(call(message))).catch((error) => console.warn("[codex-anywhere]", message.op, error));
  };

  let silentContext = null;
  function silentStream() {
    silentContext ??= new AudioContext();
    const destination = silentContext.createMediaStreamDestination();
    const source = silentContext.createConstantSource();
    source.offset.value = 0;
    source.connect(destination);
    source.start();
    return destination.stream;
  }

  // The native side captures the microphone; the page gets a silent stand-in so
  // its audio pipeline (worklet, mute bookkeeping) runs unchanged. Patch the
  // prototype, not the navigator.mediaDevices instance, so every route to
  // getUserMedia in this frame is covered however late the page reaches it.
  const mediaDevices = window.MediaDevices?.prototype ?? navigator.mediaDevices;
  const originalGetUserMedia = mediaDevices?.getUserMedia;
  if (typeof originalGetUserMedia === "function") {
    mediaDevices.getUserMedia = async function getUserMedia(constraints) {
      if (constraints?.audio && !constraints?.video) return silentStream();
      return originalGetUserMedia.call(this, constraints);
    };
    // WebKit's own audio must never interrupt other apps while native audio
    // runs. WebKit refuses microphone capture in an "ambient" session, so set
    // it only when the stand-in above is in place.
    try {
      if (navigator.audioSession) navigator.audioSession.type = "ambient";
    } catch {}
  }

  function fire(target, type, init = {}) {
    const event = type === "message" ? new MessageEvent(type, init) : new Event(type);
    if (type !== "message") Object.assign(event, init);
    try {
      target[`on${type}`]?.call(target, event);
    } catch (error) {
      console.error("[codex-anywhere] handler failed", type, error);
    }
    target.dispatchEvent(event);
  }

  class NativeDataChannel extends EventTarget {
    constructor(peer, label) {
      super();
      this.peer = peer;
      this.label = label;
      this.readyState = "connecting";
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
    }
    send(data) {
      if (this.readyState !== "open") throw new DOMException("Data channel is not open", "InvalidStateError");
      post({ op: "dcSend", pcId: this.peer.id, data: String(data) });
    }
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closing";
      post({ op: "dcClose", pcId: this.peer.id });
    }
  }

  const peers = new Map();

  class NativePeerConnection extends EventTarget {
    constructor() {
      super();
      this.id = crypto.randomUUID();
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.iceGatheringState = "new";
      this.signalingState = "stable";
      this.localDescription = null;
      this.remoteDescription = null;
      this.channel = null;
      this.onconnectionstatechange = this.oniceconnectionstatechange = null;
      this.ontrack = this.ondatachannel = this.onicecandidate = this.onnegotiationneeded = null;
      peers.set(this.id, this);
      router.register(this.id, frameDispatcher);
      this.ready = call({ op: "create", pcId: this.id });
    }
    createDataChannel(label) {
      this.channel = new NativeDataChannel(this, label);
      this.ready = this.ready.then(() => call({ op: "createDataChannel", pcId: this.id, label }));
      return this.channel;
    }
    addTrack(track, ...streams) {
      // Mirror the page's mute toggles (track.enabled) onto the native mic.
      const peer = this;
      let enabled = track.enabled;
      try {
        Object.defineProperty(track, "enabled", {
          configurable: true,
          get: () => enabled,
          set(value) {
            enabled = Boolean(value);
            // After "create" (a toggle before the peer exists must not be
            // dropped), sending whatever the value is by then.
            peer.ready.then(() => post({ op: "setMicEnabled", pcId: peer.id, enabled }), () => {});
          },
        });
      } catch {}
      this.ready = this.ready.then(() => call({ op: "setMicEnabled", pcId: this.id, enabled }));
      return { track, streams, replaceTrack: async () => {} };
    }
    addTransceiver() {
      return { direction: "sendrecv", sender: {}, receiver: {}, stop() {} };
    }
    getSenders() {
      return [];
    }
    getReceivers() {
      return [];
    }
    getTransceivers() {
      return [];
    }
    async createOffer() {
      await this.ready;
      const { sdp } = await call({ op: "createOffer", pcId: this.id });
      return { type: "offer", sdp };
    }
    async setLocalDescription(description) {
      await this.ready;
      await call({ op: "setLocalDescription", pcId: this.id, type: description.type, sdp: description.sdp });
      this.localDescription = description;
      this.signalingState = "have-local-offer";
    }
    async setRemoteDescription(description) {
      await this.ready;
      await call({ op: "setRemoteDescription", pcId: this.id, type: description.type, sdp: description.sdp });
      this.remoteDescription = description;
      this.signalingState = "stable";
    }
    async addIceCandidate() {}
    async getStats() {
      return new Map();
    }
    close() {
      if (this.connectionState === "closed") return;
      this.connectionState = "closed";
      this.signalingState = "closed";
      if (this.channel && this.channel.readyState !== "closed") {
        this.channel.readyState = "closed";
      }
      peers.delete(this.id);
      router.unregister(this.id);
      post({ op: "close", pcId: this.id });
    }
  }

  window.RTCPeerConnection = NativePeerConnection;
  window.webkitRTCPeerConnection = NativePeerConnection;

  // This frame's dispatcher; the main frame's router calls it for our peers.
  const frameDispatcher = (window.__codexAnywhereRTCFrame = {
    dispatch(event) {
      const peer = peers.get(event.pcId);
      if (!peer) return;
      switch (event.type) {
        case "connectionState":
          peer.connectionState = event.state;
          fire(peer, "connectionstatechange");
          break;
        case "iceConnectionState":
          peer.iceConnectionState = event.state;
          fire(peer, "iceconnectionstatechange");
          break;
        case "track": {
          // Audio plays natively; the page gets a silent stream for its UI.
          const stream = silentStream();
          fire(peer, "track", { track: stream.getAudioTracks()[0], streams: [stream] });
          break;
        }
        case "dcOpen":
          if (peer.channel) {
            peer.channel.readyState = "open";
            fire(peer.channel, "open");
          }
          break;
        case "dcMessage":
          if (peer.channel) fire(peer.channel, "message", { data: event.data });
          break;
        case "dcClose":
          if (peer.channel && peer.channel.readyState !== "closed") {
            peer.channel.readyState = "closed";
            fire(peer.channel, "close");
          }
          break;
      }
    },
  });
})();
