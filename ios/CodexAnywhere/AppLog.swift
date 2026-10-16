import Foundation

private let appLogQueue = DispatchQueue(label: "codex-anywhere.log")
private let appLogURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  .appendingPathComponent("codex-anywhere.log")
private let appLogTime: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withTime, .withColonSeparatorInTime, .withFractionalSeconds]
  return formatter
}()

/// Prints and appends to Documents/codex-anywhere.log, which survives app
/// restarts and can be pulled with `devicectl device copy from`.
func appLog(_ message: String) {
  print(message)
  let line = "\(appLogTime.string(from: Date())) \(message)\n"
  appLogQueue.async {
    guard let data = line.data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: appLogURL) {
      defer { try? handle.close() }
      if (try? handle.seekToEnd()) ?? 0 > 5_000_000 {
        try? handle.truncate(atOffset: 0)
      }
      try? handle.write(contentsOf: data)
    } else {
      try? data.write(to: appLogURL)
    }
  }
}
