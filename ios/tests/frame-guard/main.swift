// macOS WKWebView harness for the iOS app's frame guard (run.mjs builds and drives it).
// Compiled together with the app's real FrameGuard.swift; injects the app's
// real rtc-bridge.js and web-log.js. A fake native RTC side applies the same
// check as RTCBridge.swift and emits events back into the main frame, like
// RTCBridge.emit. WebKit's frame attribution is the same on macOS and iOS.
import AppKit
import WebKit

let args = CommandLine.arguments
let server = URL(string: args[1])!
let bridgeJS = try! String(contentsOfFile: args[2], encoding: .utf8)
let logJS = try! String(contentsOfFile: args[3], encoding: .utf8)

func describe(_ frame: WKFrameInfo) -> String {
  let o = frame.securityOrigin
  return "\(frame.isMainFrame ? "main" : "sub") \(o.protocol)://\(o.host):\(o.port)"
}

final class FakeRTC: NSObject, WKScriptMessageHandlerWithReply {
  weak var webView: WKWebView?
  var accepted: [String] = []
  var refused: [String] = []

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
    let frame = message.frameInfo
    guard FrameGuard.isAppMainFrame(frame, server: server) else {
      refused.append("rtc from \(describe(frame))")
      replyHandler(nil, "refused")
      return
    }
    let body = message.body as? [String: Any] ?? [:]
    let op = body["op"] as? String ?? "?"
    let pcId = body["pcId"] as? String ?? ""
    accepted.append("rtc \(op) from \(describe(frame))")
    switch op {
    case "createOffer": replyHandler(["sdp": "fake-offer"], nil)
    case "setRemoteDescription":
      replyHandler(nil, nil)
      for event: [String: Any] in [
        ["type": "connectionState", "state": "connected"],
        ["type": "track"],
        ["type": "dcOpen"],
        ["type": "dcMessage", "data": "hello from native"],
      ] {
        var event = event
        event["pcId"] = pcId
        let json = String(data: try! JSONSerialization.data(withJSONObject: event), encoding: .utf8)!
        webView?.evaluateJavaScript("window.__codexAnywhereRTC && window.__codexAnywhereRTC.dispatch(\(json))", in: frame, in: .page, completionHandler: nil)
      }
    default: replyHandler(nil, nil)
    }
  }
}

final class Log: NSObject, WKScriptMessageHandler {
  var accepted: [String] = []
  var refused: [String] = []
  let name: String
  init(_ name: String) { self.name = name }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    if FrameGuard.isAppMainFrame(message.frameInfo, server: server) {
      accepted.append("\(name) from \(describe(message.frameInfo)): \(String(describing: message.body).prefix(80))")
    } else {
      refused.append("\(name) from \(describe(message.frameInfo)): \(String(describing: message.body).prefix(80))")
    }
  }
}

final class UI: NSObject, WKUIDelegate {
  var media: [String] = []
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    // Same rule as AppModel.swift.
    let allowed = FrameGuard.isAppMainFrame(frame, server: server) && FrameGuard.isServerOrigin(origin, server: server)
    media.append("media request: origin \(origin.protocol)://\(origin.host):\(origin.port), frame \(describe(frame)) -> \(allowed ? "grant" : "deny")")
    decisionHandler(allowed ? .grant : .deny)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let controller = config.userContentController
FrameGuard.install(into: controller)
controller.addUserScript(WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: false))
let rtc = FakeRTC()
controller.addScriptMessageHandler(rtc, contentWorld: .page, name: "codexAnywhereRTC")
let log = Log("log")
controller.add(log, name: "codexAnywhereLog")
controller.addUserScript(WKUserScript(source: logJS, injectionTime: .atDocumentStart, forMainFrameOnly: false))
let ready = Log("ready")
controller.add(ready, contentWorld: .page, name: "codexAnywhereReady")

let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 800, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
let webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
let ui = UI()
webView.uiDelegate = ui
rtc.webView = webView
window.contentView!.addSubview(webView)
window.orderFrontRegardless()
webView.load(URLRequest(url: server))

DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
  webView.evaluateJavaScript("JSON.stringify(window.__results)") { value, error in
    let report: [String: Any] = [
      "page": (value as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } ?? String(describing: error),
      "rtcAccepted": rtc.accepted,
      "rtcRefused": rtc.refused,
      "logAccepted": log.accepted,
      "logRefused": log.refused,
      "readyAccepted": ready.accepted,
      "readyRefused": ready.refused,
      "media": ui.media,
    ]
    let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(0)
  }
}
app.run()
