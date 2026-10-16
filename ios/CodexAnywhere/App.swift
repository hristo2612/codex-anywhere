import SwiftUI

@main
struct CodexAnywhereApp: App {
  @StateObject private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(model)
    }
    .onChange(of: scenePhase) { _, phase in
      model.scenePhaseChanged(to: phase)
    }
  }
}

struct RootView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    WebViewContainer(hostView: model.hostView)
      .ignoresSafeArea()
      .background(Color(uiColor: .appBackground))
      .sheet(isPresented: $model.showingSettings) {
        SettingsView()
          .environmentObject(model)
      }
  }
}

/// Hosts the app's single, long-lived WKWebView (inside WebHostView, with its
/// loading indicator). SwiftUI may rebuild this wrapper, but the web view
/// itself (and its live session) is owned by AppModel.
struct WebViewContainer: UIViewRepresentable {
  let hostView: UIView

  func makeUIView(context: Context) -> UIView {
    let container = UIView()
    container.backgroundColor = .appBackground
    attach(to: container)
    return container
  }

  func updateUIView(_ container: UIView, context: Context) {
    if hostView.superview !== container { attach(to: container) }
  }

  private func attach(to container: UIView) {
    hostView.removeFromSuperview()
    hostView.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(hostView)
    NSLayoutConstraint.activate([
      hostView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      hostView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      hostView.topAnchor.constraint(equalTo: container.topAnchor),
      hostView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
  }
}
