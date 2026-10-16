import AVFoundation
import AudioToolbox
import WebRTC

/// WebRTC audio I/O on a VoiceProcessingIO unit that this app configures itself:
/// - `.playAndRecord` + `.allowBluetoothA2DP` (never HFP), so AirPods stay in
///   stereo and the phone's microphone is used;
/// - `.mixWithOthers` + VoiceProcessingIO "advanced ducking", so other apps'
///   music keeps playing and is ducked only while either side is talking.
/// Runs with the screen locked thanks to the `audio` background mode.
final class VoiceAudioDevice: NSObject, RTCAudioDevice {
  var musicMode: MusicMode = .duckWhileTalking

  private let sampleRate: Double = 48_000
  private let ioBufferDuration: TimeInterval = 0.01
  private var delegate: RTCAudioDeviceDelegate?
  private var unit: AudioUnit?
  private var running = false
  /// VoiceProcessingIO (echo cancellation + "advanced ducking") on the speaker
  /// or earpiece; plain RemoteIO on headphones, because iOS moves a
  /// voice-processing unit off A2DP (AirPods would drop to speaker/earpiece).
  private var voiceProcessing = true

  // Talk-triggered ducking on headphones (VPIO does its own on the speaker):
  // the playout peak is sampled on the audio thread and read by a main-thread
  // timer; other audio is ducked while the assistant speaks.
  private var playoutPeak: Float = 0
  private var loggedFirstPeak = false
  private lazy var micSpeech: MicSpeechDetector = {
    let detector = MicSpeechDetector(sampleRate: sampleRate)
    detector.onSpeech = { [weak self] in self?.userSpoke() }
    return detector
  }()
  private var duckTimer: Timer?
  private var ducked = false
  private var lastSpeech = Date.distantPast
  private static let speechPeak: Float = 0.02
  // Each duck/un-duck stalls audio I/O (~0.3 s / ~1.4 s, iOS reconfigures the
  // session), so the duck holds through the whole exchange and lifts only
  // once the conversation has been quiet for a while.
  private static let releaseAfter: TimeInterval = 5
  // Assistant voice boost on headphones (+12 dB, soft-limited).
  private static let playoutGain: Float = 4
  // Un-duck by deactivating the session (reliable per Apple's docs, but stalls
  // I/O ~1.4 s) or by dropping .duckOthers on the live session (no stall).
  private static let unduckByDeactivating = false
  private var observers: [NSObjectProtocol] = []
  // Our play-and-record session is up (between configureSession and deactivateSession).
  private var sessionActive = false

  // RTCAudioDevice state, read from WebRTC's worker threads.
  private(set) var isInitialized = false
  private(set) var isPlayoutInitialized = false
  private(set) var isPlaying = false
  private(set) var isRecordingInitialized = false
  private(set) var isRecording = false

  var deviceInputSampleRate: Double { sampleRate }
  var inputIOBufferDuration: TimeInterval { ioBufferDuration }
  var inputNumberOfChannels: Int { 1 }
  var inputLatency: TimeInterval { AVAudioSession.sharedInstance().inputLatency }
  var deviceOutputSampleRate: Double { sampleRate }
  var outputIOBufferDuration: TimeInterval { ioBufferDuration }
  var outputNumberOfChannels: Int { 1 }
  var outputLatency: TimeInterval { AVAudioSession.sharedInstance().outputLatency }

  // MARK: RTCAudioDevice

  func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
    self.delegate = delegate
    isInitialized = true
    return true
  }

  func terminateDevice() -> Bool {
    appLog("[audio] terminateDevice")
    stopUnit()
    disposeUnit()
    deactivateSession()
    delegate = nil
    isInitialized = false
    isPlayoutInitialized = false
    isRecordingInitialized = false
    return true
  }

  func initializePlayout() -> Bool {
    appLog("[audio] initializePlayout")
    isPlayoutInitialized = prepare()
    return isPlayoutInitialized
  }

  func startPlayout() -> Bool {
    appLog("[audio] startPlayout")
    isPlaying = true
    return startUnitIfNeeded()
  }

  func stopPlayout() -> Bool {
    appLog("[audio] stopPlayout")
    isPlaying = false
    stopUnitIfIdle()
    return true
  }

  func initializeRecording() -> Bool {
    appLog("[audio] initializeRecording")
    isRecordingInitialized = prepare()
    return isRecordingInitialized
  }

  func startRecording() -> Bool {
    appLog("[audio] startRecording")
    isRecording = true
    return startUnitIfNeeded()
  }

  func stopRecording() -> Bool {
    appLog("[audio] stopRecording")
    isRecording = false
    stopUnitIfIdle()
    return true
  }

  // MARK: Audio session

  private func configureSession() throws {
    let session = AVAudioSession.sharedInstance()
    // No .defaultToSpeaker: combined with .allowBluetoothA2DP it can pin output
    // to the speaker even with AirPods connected. applyOutputOverride() picks
    // the speaker only when iOS would otherwise use the quiet earpiece.
    var options: AVAudioSession.CategoryOptions = [.allowBluetoothA2DP]
    if musicMode != .pauseDuringCall { options.insert(.mixWithOthers) }
    try session.setCategory(.playAndRecord, mode: .default, options: options)
    try? session.setPreferredSampleRate(sampleRate)
    try? session.setPreferredIOBufferDuration(ioBufferDuration)
    try session.setActive(true)
    // A speaker override sticks across routes; clear it before reading the route.
    try? session.overrideOutputAudioPort(.none)
    // Keep AirPods on stereo A2DP output: record from the phone's microphone.
    if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
      try? session.setPreferredInput(builtIn)
    }
    voiceProcessing = !Self.onHeadphones(session.currentRoute)
    ducked = false
    sessionActive = true
    applyOutputOverride()
    let route = session.currentRoute
    appLog("[audio] session active out=\(route.outputs.map(\.portType.rawValue)) in=\(route.inputs.map(\.portType.rawValue)) options=\(session.categoryOptions.rawValue)")
  }

  /// Speaker instead of the earpiece; any real output (AirPods, wired,
  /// car) is left alone.
  private var baseOptions: AVAudioSession.CategoryOptions {
    musicMode == .pauseDuringCall ? [.allowBluetoothA2DP] : [.allowBluetoothA2DP, .mixWithOthers]
  }

  private var ducksWhileTalking: Bool { !voiceProcessing && musicMode == .duckWhileTalking }

  // WebRTC calls the device from its own threads, which have no run loop, so
  // the loop and every session change it makes run on the main thread.
  private func startDuckingLoop() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.ducksWhileTalking, self.duckTimer == nil else { return }
      self.duckTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
        self?.duckTick()
      }
      appLog("[audio] ducking loop on")
    }
  }

  private func stopDuckingLoop() {
    DispatchQueue.main.async { [weak self] in
      self?.duckTimer?.invalidate()
      self?.duckTimer = nil
    }
  }

  private func duckTick() {
    let peak = playoutPeak
    playoutPeak = 0
    let assistant = peak > Self.speechPeak
    if assistant, !loggedFirstPeak {
      loggedFirstPeak = true
      appLog("[audio] first assistant speech: playout=\(peak)")
    }
    let now = Date()
    if assistant {
      lastSpeech = now
      if !ducked { setDucked(true) }
    } else if ducked, now.timeIntervalSince(lastSpeech) > Self.releaseAfter {
      setDucked(false)
    }
  }

  /// iOS fades other audio down when a session with .duckOthers is activated
  /// and back up only when the session deactivates, so un-ducking briefly
  /// stops the I/O unit (the assistant has just finished speaking).
  private func setDucked(_ duck: Bool) {
    let session = AVAudioSession.sharedInstance()
    let started = Date()
    do {
      if duck {
        try session.setCategory(.playAndRecord, mode: .default, options: baseOptions.union(.duckOthers))
        try session.setActive(true)
      } else if !Self.unduckByDeactivating {
        try session.setCategory(.playAndRecord, mode: .default, options: baseOptions)
        try session.setActive(true)
      } else {
        if let unit, running { AudioOutputUnitStop(unit) }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(.playAndRecord, mode: .default, options: baseOptions)
        try session.setActive(true)
        try? session.overrideOutputAudioPort(.none)
        if let unit, running { AudioOutputUnitStart(unit) }
      }
      ducked = duck
      appLog("[audio] ducked=\(duck) in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
    } catch {
      appLog("[audio] duck \(duck) failed: \(error)")
    }
  }

  private static func onHeadphones(_ route: AVAudioSessionRouteDescription) -> Bool {
    let personal: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothLE, .headphones, .usbAudio]
    return route.outputs.contains { personal.contains($0.portType) }
  }

  private func applyOutputOverride() {
    let session = AVAudioSession.sharedInstance()
    let onReceiver = session.currentRoute.outputs.contains { $0.portType == .builtInReceiver }
    try? session.overrideOutputAudioPort(onReceiver ? .speaker : .none)
  }

  /// Voice must never play from the earpiece: it is ~20 dB quieter than the
  /// speaker and sounds like "some other source". WebRTC's own session setup
  /// and category changes clear the speaker override mid-start (seen on
  /// device: Speaker -> Receiver with reason override, then the unit
  /// initialized on the Receiver), so re-assert it whenever the route lands
  /// on the earpiece. Only ever sets .speaker, so it can't loop.
  private func keepOffEarpiece(_ context: String) {
    guard sessionActive else { return }
    let session = AVAudioSession.sharedInstance()
    let route = session.currentRoute
    guard !Self.onHeadphones(route), route.outputs.contains(where: { $0.portType == .builtInReceiver }) else { return }
    do {
      try session.overrideOutputAudioPort(.speaker)
      appLog("[audio] earpiece -> speaker (\(context))")
    } catch {
      appLog("[audio] speaker override failed (\(context)): \(error)")
    }
  }

  /// Called when the app returns to the foreground: a running play-and-record
  /// session often misses headphones connected meanwhile, so re-apply the
  /// category and rebuild the unit on whatever route is current now.
  func refreshRoute() {
    guard unit != nil else { return }
    let before = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue)
    stopUnit()
    disposeUnit()
    _ = prepare()
    _ = startUnitIfNeeded()
    let after = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue)
    appLog("[audio] refreshRoute \(before) -> \(after)")
  }

  private func deactivateSession() {
    sessionActive = false
    // Lets YouTube Music & co. resume after a "pause during voice" call.
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func observeSession() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self,
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
      else { return }
      appLog("[audio] interruption \(type.rawValue)")
      switch type {
      case .began:
        self.stopUnit()
        self.delegate?.notifyAudioInputInterrupted()
        self.delegate?.notifyAudioOutputInterrupted()
      case .ended:
        _ = self.startUnitIfNeeded()
      @unknown default:
        break
      }
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self else { return }
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
      let route = AVAudioSession.sharedInstance().currentRoute
      appLog("[audio] route change reason=\(raw) out=\(route.outputs.map(\.portType.rawValue)) in=\(route.inputs.map(\.portType.rawValue))")
      self.keepOffEarpiece("route change \(raw)")
      // Headphones came or went: the voice-processing unit stays bound to the
      // old route unless it is rebuilt, so audio kept playing on the speaker.
      if reason == .override || reason == .categoryChange { return }
      guard reason == .newDeviceAvailable || reason == .oldDeviceUnavailable, self.unit != nil else {
        self.applyOutputOverride()
        return
      }
      self.stopUnit()
      self.disposeUnit()
      _ = self.prepare()
      _ = self.startUnitIfNeeded()
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.stopUnit()
      self.disposeUnit()
      _ = self.prepare()
      _ = self.startUnitIfNeeded()
    })
  }

  // MARK: VoiceProcessingIO unit

  private func prepare() -> Bool {
    if unit != nil { return true }
    do {
      try configureSession()
    } catch {
      appLog("[audio] session error: \(error)")
      return false
    }
    observeSession()

    var description = AudioComponentDescription(
      componentType: kAudioUnitType_Output,
      componentSubType: voiceProcessing ? kAudioUnitSubType_VoiceProcessingIO : kAudioUnitSubType_RemoteIO,
      componentManufacturer: kAudioUnitManufacturer_Apple,
      componentFlags: 0,
      componentFlagsMask: 0
    )
    guard let component = AudioComponentFindNext(nil, &description) else { return false }
    var newUnit: AudioUnit?
    guard AudioComponentInstanceNew(component, &newUnit) == noErr, let newUnit else { return false }

    var enable: UInt32 = 1
    let size32 = UInt32(MemoryLayout<UInt32>.size)
    AudioUnitSetProperty(newUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enable, size32)
    AudioUnitSetProperty(newUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &enable, size32)

    var format = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      mBytesPerPacket: 2,
      mFramesPerPacket: 1,
      mBytesPerFrame: 2,
      mChannelsPerFrame: 1,
      mBitsPerChannel: 16,
      mReserved: 0
    )
    let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    // Microphone data we read (output scope of the input element).
    AudioUnitSetProperty(newUnit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, formatSize)
    // Playout data we provide (input scope of the output element).
    AudioUnitSetProperty(newUnit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format, formatSize)

    let context = Unmanaged.passUnretained(self).toOpaque()
    var render = AURenderCallbackStruct(inputProc: playoutCallback, inputProcRefCon: context)
    AudioUnitSetProperty(
      newUnit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0,
      &render, UInt32(MemoryLayout<AURenderCallbackStruct>.size))
    var input = AURenderCallbackStruct(inputProc: recordCallback, inputProcRefCon: context)
    AudioUnitSetProperty(
      newUnit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1,
      &input, UInt32(MemoryLayout<AURenderCallbackStruct>.size))

    if voiceProcessing { applyDucking(to: newUnit) }
    // Load the speech classifier now, not on the audio thread mid-call.
    if ducksWhileTalking { _ = micSpeech }

    let initStatus = AudioUnitInitialize(newUnit)
    appLog("[audio] unit initialize \(initStatus) voiceProcessing=\(voiceProcessing) route=\(AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue))")
    keepOffEarpiece("unit initialized")
    guard initStatus == noErr else {
      AudioComponentInstanceDispose(newUnit)
      return false
    }
    unit = newUnit
    return true
  }

  private func applyDucking(to unit: AudioUnit) {
    guard #available(iOS 17.0, *) else { return }
    var configuration = AUVoiceIOOtherAudioDuckingConfiguration(
      mEnableAdvancedDucking: DarwinBoolean(musicMode == .duckWhileTalking),
      mDuckingLevel: musicMode == .mix ? .min : .mid
    )
    let status = AudioUnitSetProperty(
      unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAudioUnitScope_Global, 0,
      &configuration, UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size))
    if status != noErr { appLog("[audio] ducking config status \(status)") }
  }

  private func startUnitIfNeeded() -> Bool {
    guard isPlaying || isRecording else { return true }
    if unit == nil, !prepare() { return false }
    guard let unit, !running else { return true }
    let status = AudioOutputUnitStart(unit)
    appLog("[audio] unit start \(status) playing=\(isPlaying) recording=\(isRecording)")
    running = status == noErr
    if running { startDuckingLoop() }
    return running
  }

  private func stopUnitIfIdle() {
    guard !isPlaying, !isRecording else { return }
    stopUnit()
    disposeUnit()
    deactivateSession()
  }

  private func stopUnit() {
    stopDuckingLoop()
    guard let unit, running else { return }
    AudioOutputUnitStop(unit)
    running = false
  }

  private func disposeUnit() {
    guard let unit else { return }
    AudioUnitUninitialize(unit)
    AudioComponentInstanceDispose(unit)
    self.unit = nil
  }

  // MARK: Render callbacks (audio thread)

  fileprivate func renderPlayout(
    flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    timestamp: UnsafePointer<AudioTimeStamp>,
    frames: UInt32,
    data: UnsafeMutablePointer<AudioBufferList>?
  ) -> OSStatus {
    guard let data else { return noErr }
    guard isPlaying, let delegate else {
      for buffer in UnsafeMutableAudioBufferListPointer(data) {
        if let bytes = buffer.mData { memset(bytes, 0, Int(buffer.mDataByteSize)) }
      }
      flags.pointee.insert(.unitRenderAction_OutputIsSilence)
      return noErr
    }
    let status = delegate.getPlayoutData(flags, timestamp, 0, frames, data)
    if !voiceProcessing {
      playoutPeak = max(playoutPeak, Self.peak(of: data))
      Self.boost(data, gain: Self.playoutGain)
    }
    return status
  }

  /// Your own voice on the phone mic (MicSpeechDetector). Main thread.
  private func userSpoke() {
    lastSpeech = Date()
    if ducksWhileTalking, running, !ducked { setDucked(true) }
  }

  /// Conversation activity reported by the server (either side's speech):
  /// keeps an existing duck from lifting mid-exchange. Main thread.
  func noteConversationActivity() {
    lastSpeech = Date()
  }

  private static func boost(_ list: UnsafeMutablePointer<AudioBufferList>, gain: Float) {
    for buffer in UnsafeMutableAudioBufferListPointer(list) {
      guard let bytes = buffer.mData else { continue }
      let samples = bytes.assumingMemoryBound(to: Int16.self)
      for index in 0..<Int(buffer.mDataByteSize) / 2 {
        let x = Float(samples[index]) / 32768 * gain
        // Soft limiter: linear for normal speech, smooth toward ±1 above it.
        let y = abs(x) < 0.6 ? x : (x > 0 ? 1 : -1) * (0.6 + 0.4 * tanh((abs(x) - 0.6) / 0.4))
        samples[index] = Int16(max(-32767, min(32767, y * 32767)))
      }
    }
  }

  /// Peak of the first 16-bit buffer, 0...1.
  private static func peak(of list: UnsafeMutablePointer<AudioBufferList>) -> Float {
    guard let buffer = UnsafeMutableAudioBufferListPointer(list).first, let bytes = buffer.mData else { return 0 }
    let samples = bytes.assumingMemoryBound(to: Int16.self)
    var peak: Int16 = 0
    for index in 0..<Int(buffer.mDataByteSize) / 2 {
      let magnitude = samples[index] == .min ? .max : abs(samples[index])
      if magnitude > peak { peak = magnitude }
    }
    return Float(peak) / Float(Int16.max)
  }

  fileprivate func deliverRecording(
    flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    timestamp: UnsafePointer<AudioTimeStamp>,
    bus: UInt32,
    frames: UInt32
  ) -> OSStatus {
    guard isRecording, let delegate, let unit else { return noErr }
    return delegate.deliverRecordedData(flags, timestamp, Int(bus), frames, nil, nil) {
      renderFlags, renderTimestamp, renderBus, renderFrames, bufferList, _ in
      let status = AudioUnitRender(unit, renderFlags, renderTimestamp, UInt32(renderBus), renderFrames, bufferList)
      if status == noErr, self.ducksWhileTalking,
         let buffer = UnsafeMutableAudioBufferListPointer(bufferList).first, let bytes = buffer.mData {
        self.micSpeech.append(bytes.assumingMemoryBound(to: Int16.self), count: Int(buffer.mDataByteSize) / 2)
      }
      return status
    }
  }
}

private let playoutCallback: AURenderCallback = { refCon, flags, timestamp, _, frames, data in
  let device = Unmanaged<VoiceAudioDevice>.fromOpaque(refCon).takeUnretainedValue()
  return device.renderPlayout(flags: flags, timestamp: timestamp, frames: frames, data: data)
}

private let recordCallback: AURenderCallback = { refCon, flags, timestamp, bus, frames, _ in
  let device = Unmanaged<VoiceAudioDevice>.fromOpaque(refCon).takeUnretainedValue()
  return device.deliverRecording(flags: flags, timestamp: timestamp, bus: bus, frames: frames)
}
