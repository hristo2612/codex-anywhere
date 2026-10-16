import UIKit
import WebKit

extension UIColor {
  /// The page's background in light and dark mode; also the launch screen's.
  static let appBackground = UIColor(named: "AppBackground") ?? .systemBackground
}

/// Hosts the app's one web view and, over it, a plain loading indicator while
/// a fresh page boots (cold launch, reload after iOS killed the page).
final class WebHostView: UIView {
  /// The indicator never outlasts this, even if the page never says it's ready.
  static let loadingTimeout: Duration = .seconds(12)

  let webView: WKWebView
  private let loadingView = UIView()
  private let spinner = UIActivityIndicatorView(style: .large)
  private var isLoading = false
  private var loadingSince: CFTimeInterval = 0
  private var timeout: Task<Void, Never>?

  init(webView: WKWebView) {
    self.webView = webView
    super.init(frame: .zero)
    backgroundColor = .appBackground
    webView.frame = bounds
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(webView)

    // Never takes touches: the page underneath is usable the moment it renders.
    loadingView.isUserInteractionEnabled = false
    loadingView.backgroundColor = .appBackground
    loadingView.frame = bounds
    loadingView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    loadingView.isHidden = true
    spinner.translatesAutoresizingMaskIntoConstraints = false
    loadingView.addSubview(spinner)
    NSLayoutConstraint.activate([
      spinner.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: loadingView.centerYAnchor),
    ])
    addSubview(loadingView)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func showLoading() {
    loadingView.layer.removeAllAnimations()
    loadingView.alpha = 1
    loadingView.isHidden = false
    spinner.startAnimating()
    if !isLoading { loadingSince = CACurrentMediaTime() }
    isLoading = true
    scheduleTimeout()
  }

  /// Fades the indicator out: the page is ready, failed (its error must be
  /// visible), or took too long.
  func hideLoading(reason: String) {
    timeout?.cancel()
    timeout = nil
    guard isLoading else { return }
    isLoading = false
    appLog("[loading] hide (\(reason)) after \(Int((CACurrentMediaTime() - loadingSince) * 1000)) ms")
    UIView.animate(
      withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction],
      animations: { self.loadingView.alpha = 0 },
      completion: { _ in
        guard !self.isLoading else { return }
        self.loadingView.isHidden = true
        self.spinner.stopAnimating()
      }
    )
  }

  /// Gives a still-visible indicator its full time again, e.g. when the app
  /// comes back to the foreground after the timer ran on while suspended.
  func restartLoadingTimeout() {
    if isLoading { scheduleTimeout() }
  }

  private func scheduleTimeout() {
    timeout?.cancel()
    timeout = Task { [weak self] in
      try? await Task.sleep(for: Self.loadingTimeout)
      guard !Task.isCancelled else { return }
      self?.hideLoading(reason: "timeout")
    }
  }
}
