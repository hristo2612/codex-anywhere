import Foundation
import WebKit

/// Native code answers only the app's own page: the main frame, on the
/// server's origin (scheme, host and port).
///
/// Plugin pages (MCP Apps) render in iframes on another origin (the sandbox
/// port), and their content is someone else's code; nothing they post may
/// reach the microphone, the logs or the loading screen. The voice window is a
/// same-origin iframe: it calls the main frame's handlers
/// (`top.webkit.messageHandlers`), which WebKit reports as the main frame.
/// A cross-origin frame cannot touch `top`, so it has no way in.
enum FrameGuard {
  /// The main-frame marker the web page checks before it enables plugin pages
  /// (src/browser/shim.ts): builds without it answered every frame.
  static let markerScript = WKUserScript(
    source: "Object.defineProperty(window, \"__codexAnywhereFrameGuard\", { value: 1 });",
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true,
    in: .page
  )

  static func install(into controller: WKUserContentController) {
    controller.addUserScript(markerScript)
  }

  /// True only for the main frame of `server`'s origin.
  static func isAppMainFrame(_ frame: WKFrameInfo, server: URL?) -> Bool {
    frame.isMainFrame && isServerOrigin(frame.securityOrigin, server: server)
  }

  static func isServerOrigin(_ origin: WKSecurityOrigin, server: URL?) -> Bool {
    guard let server,
          let scheme = server.scheme?.lowercased(),
          scheme == "https" || scheme == "http",
          let host = server.host?.lowercased(),
          !host.isEmpty
    else { return false }
    let defaultPort = scheme == "https" ? 443 : 80
    // WKSecurityOrigin reports a default port as 0.
    let originPort = origin.port == 0 ? defaultPort : origin.port
    return origin.protocol.lowercased() == scheme
      && origin.host.lowercased() == host
      && originPort == (server.port ?? defaultPort)
  }
}
