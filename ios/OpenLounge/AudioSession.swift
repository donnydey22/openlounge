import AVFoundation
import os

/// Owns the app-wide AVAudioSession configuration for live audio rooms.
final class AudioSession {
    static let shared = AudioSession()

    private let log = Logger(subsystem: "com.donnydey.openlounge", category: "audio")
    private var observing = false

    private init() {}

    func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            log.error("AVAudioSession setup failed: \(error.localizedDescription, privacy: .public)")
        }
        startObserving()
    }

    /// Ask for the OS microphone permission up front (like the Android wrapper does) so the
    /// first getUserMedia() call from LiveKit doesn't race the system prompt.
    func requestMicrophonePermissionIfNeeded() {
        if #available(iOS 17.0, *) {
            if AVAudioApplication.shared.recordPermission == .undetermined {
                AVAudioApplication.requestRecordPermission { _ in }
            }
        } else {
            let session = AVAudioSession.sharedInstance()
            if session.recordPermission == .undetermined {
                session.requestRecordPermission { _ in }
            }
        }
    }

    private func startObserving() {
        guard !observing else { return }
        observing = true
        let center = NotificationCenter.default
        center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            guard
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                let type = AVAudioSession.InterruptionType(rawValue: raw),
                type == .ended
            else { return }
            self?.activate()
        }
        center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] _ in
            self?.activate()
        }
    }
}
