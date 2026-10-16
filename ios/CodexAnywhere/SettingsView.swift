import SwiftUI

struct SettingsView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var draftURL = ""

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("https://your-mac.ts.net:8200/", text: $draftURL)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } header: {
          Text("Server")
        } footer: {
          Text("The codex-anywhere server, reachable over Tailscale.")
        }

        Section {
          Picker("Music", selection: $model.musicModeRaw) {
            ForEach(MusicMode.allCases) { mode in
              Text(mode.title).tag(mode.rawValue)
            }
          }
          .pickerStyle(.inline)
          .labelsHidden()
        } header: {
          Text("Voice and music")
        } footer: {
          Text("Applies from the next voice chat. Start voice with the phone unlocked; it keeps going when you lock it.")
        }

        Section {
          Button("Reload page") {
            model.load()
            dismiss()
          }
        }
      }
      .navigationTitle("Codex Anywhere")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            var trimmed = draftURL.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, !trimmed.contains("://") {
              trimmed = "https://" + trimmed
            }
            if !trimmed.isEmpty, trimmed != model.serverURL {
              model.changeServerURL(to: trimmed)
            }
            dismiss()
          }
          // Without a server there is nothing behind this sheet.
          .disabled(model.serverURL.isEmpty && draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .onAppear { draftURL = model.serverURL }
    }
  }
}
