import Foundation
import WebKit
import WebRTC

/// Native side of rtc-bridge.js: runs the voice window's WebRTC call with the
/// app's own audio device so the app owns the iOS audio session.
@MainActor
final class RTCBridge: NSObject {
  static let handlerName = "codexAnywhereRTC"

  weak var webView: WKWebView?
  /// The server whose main frame may use the bridge (FrameGuard).
  var serverURL: () -> URL? = { nil }
  var musicMode: MusicMode = .duckWhileTalking {
    didSet { audioDevice.musicMode = musicMode }
  }

  private let audioDevice = VoiceAudioDevice()
  private lazy var factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory(
      encoderFactory: RTCDefaultVideoEncoderFactory(),
      decoderFactory: RTCDefaultVideoDecoderFactory(),
      audioDevice: audioDevice
    )
  }()
  private var peers: [String: Peer] = [:]

  /// Realtime server events on the data channel; transcript events mean
  /// someone is speaking (the server's own speech detection, so no noise).
  fileprivate func noteServerEvent(_ text: String) {
    if text.hasPrefix("{\"type\":\"input_transcript") || text.hasPrefix("{\"type\":\"output_transcript") {
      audioDevice.noteConversationActivity()
    }
  }

  /// See VoiceAudioDevice.refreshRoute().
  func refreshAudioRoute() {
    audioDevice.refreshRoute()
  }

  /// rtc-bridge.js goes into every frame: the main frame keeps the event
  /// router, the voice window (a same-origin iframe) runs the call through the
  /// main frame's handler. Messages are answered only for the main frame of
  /// the server's origin (FrameGuard); events go back to that frame.
  func install(into controller: WKUserContentController) {
    if let url = Bundle.main.url(forResource: "rtc-bridge", withExtension: "js"),
       let source = try? String(contentsOf: url, encoding: .utf8) {
      controller.addUserScript(
        WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
      )
    }
    controller.addScriptMessageHandler(self, contentWorld: .page, name: Self.handlerName)
  }

  fileprivate func emit(_ event: [String: Any], to frame: WKFrameInfo) {
    guard let webView,
          let data = try? JSONSerialization.data(withJSONObject: event),
          let json = String(data: data, encoding: .utf8)
    else { return }
    webView.evaluateJavaScript(
      "window.__codexAnywhereRTC && window.__codexAnywhereRTC.dispatch(\(json))",
      in: frame,
      in: .page,
      completionHandler: nil
    )
  }

  private func handle(_ body: [String: Any], frame: WKFrameInfo) async throws -> Any? {
    guard let op = body["op"] as? String, let pcId = body["pcId"] as? String else {
      throw BridgeError("malformed message")
    }
    if op == "create" {
      peers[pcId]?.close()
      peers[pcId] = try Peer(id: pcId, frame: frame, factory: factory, bridge: self)
      audioDevice.musicMode = musicMode
      return nil
    }
    guard let peer = peers[pcId] else {
      if op == "close" { return nil }
      throw BridgeError("unknown peer \(pcId)")
    }
    switch op {
    case "createDataChannel":
      peer.createDataChannel(label: body["label"] as? String ?? "oai-events")
      return nil
    case "setMicEnabled":
      peer.setMicEnabled(body["enabled"] as? Bool ?? true)
      return nil
    case "createOffer":
      return ["sdp": try await peer.createOffer()]
    case "setLocalDescription":
      try await peer.setDescription(local: true, type: body["type"] as? String, sdp: body["sdp"] as? String)
      return nil
    case "setRemoteDescription":
      try await peer.setDescription(local: false, type: body["type"] as? String, sdp: body["sdp"] as? String)
      return nil
    case "dcSend":
      peer.send(body["data"] as? String ?? "")
      return nil
    case "dcClose":
      peer.closeDataChannel()
      return nil
    case "close":
      peer.close()
      peers[pcId] = nil
      return nil
    default:
      throw BridgeError("unknown op \(op)")
    }
  }
}

extension RTCBridge: WKScriptMessageHandlerWithReply {
  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    let frame = message.frameInfo
    guard FrameGuard.isAppMainFrame(frame, server: serverURL()) else {
      let origin = frame.securityOrigin
      appLog("[rtc] refused a message from \(frame.isMainFrame ? "main" : "sub") frame \(origin.protocol)://\(origin.host):\(origin.port)")
      replyHandler(nil, "refused")
      return
    }
    guard let body = message.body as? [String: Any] else {
      replyHandler(nil, "malformed message")
      return
    }
    let op = body["op"] as? String ?? "?"
    if op != "dcSend" { appLog("[rtc] \(op) \(body["pcId"] as? String ?? "")") }
    Task { @MainActor in
      do {
        replyHandler(try await self.handle(body, frame: frame), nil)
      } catch {
        appLog("[rtc] \(op) failed: \(error)")
        replyHandler(nil, String(describing: error))
      }
    }
  }
}

struct BridgeError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// One RTCPeerConnection mirrored from the page.
@MainActor
private final class Peer: NSObject {
  let id: String
  let frame: WKFrameInfo
  private weak var bridge: RTCBridge?
  private var connection: RTCPeerConnection!
  private let micTrack: RTCAudioTrack
  private var dataChannel: RTCDataChannel?
  private var announcedTrack = false
  private var closed = false

  init(id: String, frame: WKFrameInfo, factory: RTCPeerConnectionFactory, bridge: RTCBridge) throws {
    self.id = id
    self.frame = frame
    self.bridge = bridge
    let source = factory.audioSource(with: RTCMediaConstraints(
      mandatoryConstraints: nil, optionalConstraints: nil))
    micTrack = factory.audioTrack(with: source, trackId: "codex-anywhere-mic")
    super.init()

    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    guard let connection = factory.peerConnection(
      with: configuration,
      constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil),
      delegate: self
    ) else { throw BridgeError("could not create peer connection") }
    self.connection = connection
    connection.add(micTrack, streamIds: ["codex-anywhere"])
  }

  func createDataChannel(label: String) {
    let channel = connection.dataChannel(forLabel: label, configuration: RTCDataChannelConfiguration())
    channel?.delegate = self
    dataChannel = channel
  }

  func setMicEnabled(_ enabled: Bool) {
    micTrack.isEnabled = enabled
  }

  func createOffer() async throws -> String {
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    return try await withCheckedThrowingContinuation { continuation in
      connection.offer(for: constraints) { description, error in
        if let description {
          continuation.resume(returning: description.sdp)
        } else {
          continuation.resume(throwing: error ?? BridgeError("offer failed"))
        }
      }
    }
  }

  func setDescription(local: Bool, type: String?, sdp: String?) async throws {
    guard let sdp else { throw BridgeError("missing sdp") }
    let description = RTCSessionDescription(type: RTCSessionDescription.type(for: type ?? "offer"), sdp: sdp)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let done: @Sendable (Error?) -> Void = { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
      if local {
        connection.setLocalDescription(description, completionHandler: done)
      } else {
        connection.setRemoteDescription(description, completionHandler: done)
      }
    }
  }

  func send(_ text: String) {
    guard let data = text.data(using: .utf8) else { return }
    dataChannel?.sendData(RTCDataBuffer(data: data, isBinary: false))
  }

  func closeDataChannel() {
    dataChannel?.close()
  }

  func close() {
    guard !closed else { return }
    closed = true
    dataChannel?.close()
    connection.close()
  }

  fileprivate func emit(_ event: [String: Any]) {
    var event = event
    event["pcId"] = id
    bridge?.emit(event, to: frame)
  }
}

extension Peer: RTCPeerConnectionDelegate {
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    let state: String = switch newState {
    case .new: "new"
    case .connecting: "connecting"
    case .connected: "connected"
    case .disconnected: "disconnected"
    case .failed: "failed"
    case .closed: "closed"
    @unknown default: "new"
    }
    appLog("[rtc] connectionState \(state)")
    Task { @MainActor in self.emit(["type": "connectionState", "state": state]) }
  }

  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    let state: String = switch newState {
    case .new: "new"
    case .checking: "checking"
    case .connected: "connected"
    case .completed: "completed"
    case .failed: "failed"
    case .disconnected: "disconnected"
    case .closed: "closed"
    case .count: "new"
    @unknown default: "new"
    }
    appLog("[rtc] iceConnectionState \(state)")
    Task { @MainActor in self.emit(["type": "iceConnectionState", "state": state]) }
  }

  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
    appLog("[rtc] didStartReceiving media=\(transceiver.mediaType.rawValue)")
    guard transceiver.mediaType == .audio else { return }
    Task { @MainActor in
      guard !self.announcedTrack else { return }
      self.announcedTrack = true
      self.emit(["type": "track"])
    }
  }

  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

extension Peer: RTCDataChannelDelegate {
  nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    let state = dataChannel.readyState
    appLog("[rtc] dataChannel state \(state.rawValue)")
    Task { @MainActor in
      switch state {
      case .open: self.emit(["type": "dcOpen"])
      case .closed: self.emit(["type": "dcClose"])
      default: break
      }
    }
  }

  nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    let text = String(data: buffer.data, encoding: .utf8) ?? ""
    Task { @MainActor in
      self.bridge?.noteServerEvent(text)
      self.emit(["type": "dcMessage", "data": text])
    }
  }
}
