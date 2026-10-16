import SwiftUI
import WebKit

/// How the native voice call treats other apps' audio (e.g. YouTube Music).
enum MusicMode: String, CaseIterable, Identifiable {
  /// Keep other audio playing; iOS ducks it while either side speaks.
  case duckWhileTalking
  /// Pause other audio for the whole voice call.
  case pauseDuringCall
  /// Mix without any ducking.
  case mix

  var id: String { rawValue }

  var title: String {
    switch self {
    case .duckWhileTalking: "Duck music while talking"
    case .pauseDuringCall: "Pause music during voice"
    case .mix: "Keep music at full volume"
    }
  }
}

@MainActor
final class AppModel: NSObject, ObservableObject {
  /// Set at build time (CODEX_ANYWHERE_SERVER_URL in ios/Config); empty opens Settings.
  static let defaultServerURL = Bundle.main.object(forInfoDictionaryKey: "CodexAnywhereServerURL") as? String ?? ""
  /// The page the user was on when the app last left the foreground.
  private static let lastPageKey = "lastPageURL"

  @Published var showingSettings = false
  @AppStorage("serverURL") var serverURL: String = AppModel.defaultServerURL
  @AppStorage("musicMode") var musicModeRaw: String = MusicMode.duckWhileTalking.rawValue {
    didSet { rtcBridge.musicMode = musicMode }
  }

  var musicMode: MusicMode { MusicMode(rawValue: musicModeRaw) ?? .duckWhileTalking }

  let webView: WKWebView
  let hostView: WebHostView
  let rtcBridge: RTCBridge

  private let launchStart = CACurrentMediaTime()
  /// The thread being reopened at launch, until it renders or is given up.
  private var restoringURL: URL?

  override init() {
    Self.removeOldPageSnapshots()
    let server = URL(string: UserDefaults.standard.string(forKey: "serverURL") ?? Self.defaultServerURL)
    let launchURL = server.map { Self.savedPage(server: $0) ?? $0 }

    let bridge = RTCBridge()
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.websiteDataStore = .default()
    FrameGuard.install(into: configuration.userContentController)
    bridge.install(into: configuration.userContentController)
    let webLog = WebLog.install(into: configuration.userContentController)
    let readyRelay = PageReadyBridge.install(into: configuration.userContentController)

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isInspectable = true
    webView.allowsBackForwardNavigationGestures = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.bounces = false
    webView.isOpaque = false
    webView.backgroundColor = .appBackground

    self.webView = webView
    self.hostView = WebHostView(webView: webView)
    self.rtcBridge = bridge
    super.init()

    readyRelay.target = self
    bridge.webView = webView
    bridge.serverURL = { [weak self] in self?.currentServerURL }
    webLog.serverURL = { [weak self] in self?.currentServerURL }
    bridge.musicMode = musicMode
    webView.navigationDelegate = self
    webView.uiDelegate = self

    let settingsGesture = UITapGestureRecognizer(target: self, action: #selector(openSettings))
    settingsGesture.numberOfTouchesRequired = 3
    settingsGesture.numberOfTapsRequired = 2
    webView.addGestureRecognizer(settingsGesture)

    hostView.showLoading()
    if let launchURL, let server, launchURL != server {
      appLog("[launch] reopening \(Self.pagePath(launchURL))")
      restoringURL = launchURL
      webView.load(URLRequest(url: launchURL))
    } else {
      load()
    }
  }

  /// Loads the server's root page.
  func load() {
    restoringURL = nil
    guard let url = URL(string: serverURL) else {
      showingSettings = true
      return
    }
    webView.load(URLRequest(url: url))
  }

  /// Switches servers: the saved page belongs to the old one.
  func changeServerURL(to url: String) {
    serverURL = url
    UserDefaults.standard.removeObject(forKey: Self.lastPageKey)
    load()
  }

  func scenePhaseChanged(to phase: ScenePhase) {
    switch phase {
    case .active:
      rtcBridge.refreshAudioRoute()
      hostView.restartLoadingTimeout()
    case .inactive, .background:
      savePagePosition()
    @unknown default:
      break
    }
  }

  @objc private func openSettings() {
    showingSettings = true
  }

  /// The server whose main frame native code answers (FrameGuard).
  private var currentServerURL: URL? { URL(string: serverURL) }

  private func pageDidBecomeReady() {
    restoringURL = nil
    hostView.hideLoading(reason: "ready")
  }

  /// Earlier builds kept a picture of the page in Caches; it can show chat
  /// content, so delete it (off the main thread; a no-op once it's gone).
  private static func removeOldPageSnapshots() {
    Task.detached(priority: .utility) {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      try? FileManager.default.removeItem(at: caches.appendingPathComponent("PageSnapshot", isDirectory: true))
    }
  }

  // MARK: Reopen where the user left off

  /// Remembers the current page for the next launch.
  private func savePagePosition() {
    guard let url = webView.url, let server = URL(string: serverURL) else { return }
    if let page = Self.restorablePage(url, server: server) {
      UserDefaults.standard.set(page.absoluteString, forKey: Self.lastPageKey)
    } else if Self.sameOrigin(url, server) {
      UserDefaults.standard.removeObject(forKey: Self.lastPageKey)
    }
  }

  /// The saved thread page, if it still belongs to `server`.
  private static func savedPage(server: URL) -> URL? {
    guard let saved = UserDefaults.standard.string(forKey: lastPageKey),
          let url = URL(string: saved),
          let page = restorablePage(url, server: server),
          pagePath(page) != "/"
    else { return nil }
    return page
  }

  /// `url` as a page the app may reopen: the server's origin, path "/" or
  /// "/thread/<id>", no query or fragment.
  private static func restorablePage(_ url: URL, server: URL) -> URL? {
    guard sameOrigin(url, server),
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    let path = components.percentEncodedPath
    guard path == "/" || path.range(of: #"^/thread/[^/]+$"#, options: .regularExpression) != nil else {
      return nil
    }
    components.percentEncodedQuery = nil
    components.percentEncodedFragment = nil
    return components.url
  }

  private static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
    guard let scheme = a.scheme?.lowercased(), scheme == b.scheme?.lowercased(),
          let host = a.host?.lowercased(), host == b.host?.lowercased()
    else { return false }
    let defaultPort = scheme == "https" ? 443 : 80
    return (a.port ?? defaultPort) == (b.port ?? defaultPort)
  }

  private static func pagePath(_ url: URL) -> String {
    let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
    return path.isEmpty ? "/" : path
  }

  /// Errors that say the server is unreachable right now rather than that the
  /// page is bad; a restored page is retried rather than given up for these.
  private static func isConnectivityError(_ error: NSError) -> Bool {
    guard error.domain == NSURLErrorDomain else { return false }
    return [
      NSURLErrorNotConnectedToInternet, NSURLErrorTimedOut, NSURLErrorCannotFindHost,
      NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorDNSLookupFailed,
      NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff,
    ].contains(error.code)
  }
}

extension AppModel: WKScriptMessageHandler {
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == PageReadyBridge.handlerName,
          FrameGuard.isAppMainFrame(message.frameInfo, server: currentServerURL)
    else { return }
    let body = message.body as? [String: Any] ?? [:]
    let source = body["source"] as? String ?? "?"
    let path = body["path"] as? String ?? "?"
    let pageMs = (body["ms"] as? NSNumber)?.intValue ?? -1
    let appMs = Int((CACurrentMediaTime() - launchStart) * 1000)
    appLog("[ready] \(source) \(path): page \(pageMs) ms, app launch +\(appMs) ms")
    pageDidBecomeReady()
  }
}

extension AppModel: WKNavigationDelegate {
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // iOS reclaimed the page's web content process. Reloading boots a fresh
    // page, which opens a new server session (the old one is not resumed) and
    // loads its state from the server again; show loading until it's ready.
    appLog("[web] content process terminated; reloading")
    hostView.showLoading()
    if webView.url == nil { load() } else { webView.reload() }
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    let error = error as NSError
    // Superseded by a newer load; that one reports for itself.
    if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return }
    let failed = (error.userInfo[NSURLErrorFailingURLErrorKey] as? URL).map(Self.pagePath) ?? "?"
    appLog("[web] load of \(failed) failed: \(error.domain) \(error.code) \(error.localizedDescription)")
    hostView.hideLoading(reason: "load failed")
    if let restoring = restoringURL, !Self.isConnectivityError(error) {
      appLog("[launch] could not reopen \(Self.pagePath(restoring)); loading the root page")
      UserDefaults.standard.removeObject(forKey: Self.lastPageKey)
      load()
      return
    }
    // Usually Tailscale is off or the Mac is asleep; retry shortly.
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
      guard let self else { return }
      if let restoring = self.restoringURL {
        self.webView.load(URLRequest(url: restoring))
      } else {
        self.load()
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    let error = error as NSError
    if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return }
    appLog("[web] page failed: \(error.domain) \(error.code) \(error.localizedDescription)")
    hostView.hideLoading(reason: "page failed")
  }
}

extension AppModel: WKUIDelegate {
  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    // Only the app's own page (composer dictation). Voice runs natively, and
    // plugin pages in iframes never get the microphone or the camera.
    let server = currentServerURL
    let allowed = FrameGuard.isAppMainFrame(frame, server: server) && FrameGuard.isServerOrigin(origin, server: server)
    if !allowed {
      appLog("[media] denied \(type == .microphone ? "microphone" : "camera") to \(frame.isMainFrame ? "main" : "sub") frame \(frame.securityOrigin.protocol)://\(frame.securityOrigin.host):\(frame.securityOrigin.port)")
    }
    decisionHandler(allowed ? .grant : .deny)
  }

  // window.open / target=_blank: hand web links to Safari. Other schemes
  // (tel:, sms:, other apps' URL schemes) are never opened from the page.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url,
       let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" {
      UIApplication.shared.open(url)
    } else {
      appLog("[web] not opening a popup with scheme \(navigationAction.request.url?.scheme ?? "none")")
    }
    return nil
  }
}

/// Forwards page warnings, errors and frame loads from the app's own frames
/// (the main frame and same-origin iframes such as the voice window) to the
/// app's stdout, so `devicectl device process launch --console` shows what the
/// web view is doing on a real device. Same-origin iframes post through the
/// main frame's handler; Swift answers only the main frame (FrameGuard), so
/// plugin pages on the sandbox origin cannot write to the log.
final class WebLog: NSObject, WKScriptMessageHandler {
  static let handlerName = "codexAnywhereLog"

  /// The server whose main frame may log (FrameGuard).
  var serverURL: () -> URL? = { nil }

  static func install(into controller: WKUserContentController) -> WebLog {
    let log = WebLog()
    controller.add(log, name: handlerName)
    if let url = Bundle.main.url(forResource: "web-log", withExtension: "js"),
       let source = try? String(contentsOf: url, encoding: .utf8) {
      controller.addUserScript(
        WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
      )
    }
    return log
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard FrameGuard.isAppMainFrame(message.frameInfo, server: serverURL()) else { return }
    appLog("[web] \(message.body)")
  }
}
