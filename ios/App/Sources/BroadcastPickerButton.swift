import ReplayKit
import SwiftUI

struct BroadcastPickerButton: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: .zero)
        picker.preferredExtension = StreamDefaults.broadcastExtensionBundleIdentifier
        picker.showsMicrophoneButton = false
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {
        uiView.preferredExtension = StreamDefaults.broadcastExtensionBundleIdentifier
        uiView.showsMicrophoneButton = false
    }
}