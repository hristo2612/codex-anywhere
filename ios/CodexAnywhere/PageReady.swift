import WebKit

/// Tells the app, once per page load, that the page's live UI has rendered, so
/// the loading indicator can make way for it. Main frame only: the voice window
/// runs in same-origin iframes that must not count.
enum PageReadyBridge {
  static let handlerName = "codexAnywhereReady"

  /// Installs the script and returns its message relay; set the relay's
  /// target to receive `{ source, path, snapshot, ms }`.
  static func install(into controller: WKUserContentController) -> WeakScriptMessageHandler {
    let relay = WeakScriptMessageHandler()
    controller.add(relay, contentWorld: .page, name: handlerName)
    controller.addUserScript(
      WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
    )
    return relay
  }

  private static let source = """
  (() => {
    const handler = window.webkit?.messageHandlers?.codexAnywhereReady;
    if (!handler || window.__codexAnywhereReady) return;
    window.__codexAnywhereReady = true;

    let sent = false;
    let observer = null;
    const post = (source, detail) => {
      if (sent) return;
      sent = true;
      observer?.disconnect();
      try {
        handler.postMessage({
          source,
          path: typeof detail.path === "string" ? detail.path : location.pathname,
          snapshot: detail.snapshot === true,
          ms: typeof detail.ms === "number" ? detail.ms : Math.round(performance.now()),
        });
      } catch {}
    };

    // Server builds that announce their first live render.
    addEventListener("codex-web:ready", (event) => post("event", event.detail || {}));

    // Otherwise (current builds): the app shell plus the composer (and, on a
    // thread, the conversation's text) count as rendered. The web snapshot
    // overlay (#codex-instant-paint) is a picture of the same UI; skip it.
    const live = (selector) =>
      [...document.querySelectorAll(selector)].find((el) => !el.closest("#codex-instant-paint"));
    const rendered = () => {
      if (!live("[data-app-shell-frame]")) return false;
      if (!live("[data-codex-composer]")) return false;
      if (!location.pathname.startsWith("/thread/")) return true;
      const main = live("main[data-app-shell-main-surface]");
      return !!main && main.textContent.length > 400;
    };
    let queued = false;
    const check = () => {
      queued = false;
      if (!sent && rendered()) post("dom", {});
    };
    observer = new MutationObserver(() => {
      if (queued || sent) return;
      queued = true;
      requestAnimationFrame(check);
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  })();
  """
}

/// Forwards script messages to a target it holds weakly: the user content
/// controller retains its handlers for as long as the web view lives.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}
