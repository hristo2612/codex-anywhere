import AVFoundation
import SoundAnalysis

/// Detects the wearer's own speech on the phone microphone. Apple's built-in
/// sound classifier must hear speech (not noise or music) AND the level must be
/// close-range loud, well above the room's background: the phone is near the
/// wearer, while other people in the room reach it much quieter.
final class MicSpeechDetector: NSObject, SNResultsObserving {
  /// Main thread.
  var onSpeech: (() -> Void)?

  private let queue = DispatchQueue(label: "codex-anywhere.mic-speech")
  private let format: AVAudioFormat
  private let analyzer: SNAudioStreamAnalyzer
  private var framePosition: AVAudioFramePosition = 0
  // Queue-confined state.
  private var windowLevelDb: Float = -120
  private var noiseFloorDb: Float = -60
  private var loggedDetections = 0

  private static let minLevelDb: Float = -38
  private static let aboveFloorDb: Float = 14
  private static let minConfidence = 0.6

  init(sampleRate: Double) {
    format = AVAudioFormat(
      commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    analyzer = SNAudioStreamAnalyzer(format: format)
    super.init()
    do {
      let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
      // Shortest window the classifier allows, for the quickest reaction.
      switch request.windowDurationConstraint {
      case .enumeratedDurations(let durations):
        if let shortest = durations.min(by: { $0.seconds < $1.seconds }) { request.windowDuration = shortest }
      case .durationRange(let range):
        request.windowDuration = range.start
      @unknown default:
        break
      }
      request.overlapFactor = 0.75
      try analyzer.add(request, withObserver: self)
      appLog("[mic] speech classifier window=\(request.windowDuration.seconds)s")
    } catch {
      appLog("[mic] speech classifier unavailable: \(error)")
    }
  }

  /// Audio thread: copy the samples and analyze them off the audio thread.
  func append(_ samples: UnsafePointer<Int16>, count: Int) {
    guard count > 0 else { return }
    var chunk = [Float](repeating: 0, count: count)
    var sumSquares: Float = 0
    for index in 0..<count {
      let value = Float(samples[index]) / 32768
      chunk[index] = value
      sumSquares += value * value
    }
    let levelDb = 20 * log10(max(sqrt(sumSquares / Float(count)), 1e-6))
    queue.async { [weak self] in
      guard let self,
            let buffer = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: AVAudioFrameCount(count))
      else { return }
      self.windowLevelDb = max(self.windowLevelDb, levelDb)
      // Background level: follows quiet moments at once, rises ~1 dB/s.
      self.noiseFloorDb = levelDb < self.noiseFloorDb ? levelDb : self.noiseFloorDb + 0.01
      buffer.frameLength = AVAudioFrameCount(count)
      chunk.withUnsafeBufferPointer { source in
        buffer.floatChannelData![0].update(from: source.baseAddress!, count: count)
      }
      self.analyzer.analyze(buffer, atAudioFramePosition: self.framePosition)
      self.framePosition += AVAudioFramePosition(count)
    }
  }

  // Called on `queue`, synchronously inside analyze().
  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let result = result as? SNClassificationResult else { return }
    let confidence = result.classification(forIdentifier: "speech")?.confidence ?? 0
    let level = windowLevelDb
    windowLevelDb = -120
    guard confidence >= Self.minConfidence else { return }
    let near = level > Self.minLevelDb && level > noiseFloorDb + Self.aboveFloorDb
    if loggedDetections < 40 {
      loggedDetections += 1
      appLog(String(format: "[mic] speech conf=%.2f level=%.1f dB floor=%.1f dB -> %@",
                    confidence, level, noiseFloorDb, near ? "duck" : "ignored (not close/loud)"))
    }
    guard near else { return }
    DispatchQueue.main.async { [weak self] in self?.onSpeech?() }
  }

  func request(_ request: SNRequest, didFailWithError error: Error) {
    appLog("[mic] speech classifier failed: \(error)")
  }
}
