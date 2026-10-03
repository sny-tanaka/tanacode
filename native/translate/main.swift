// tanacode の翻訳の補助プログラム。macOS 標準の翻訳（Translation フレームワーク、macOS 15 以降）で、文を日本語に訳す。
// 作り方は scripts/build-translate-helper.mjs、呼ぶのは src/main/translate.ts。
//
// 標準入力: {"texts": ["…", …]}（JSON）
// 標準出力: 結果の JSON を 1 行
//   訳せた:   {"ok":true,"texts":["…", …],"source":"en"}（texts は入力と同じ順・同じ数）
//   訳せない: {"ok":false,"error":"same-language | not-installed | unsupported | failed","source":"en","message":"…"}
//
// - 訳すのは Mac の中だけ。翻訳データ（言語）が入っているときだけ訳す。
//   入っていないまま訳そうとすると、Translation はダウンロードの確認を出そうとして止まる（窓が画面の外なので見えない）。
//   そのため先に確かめ、入っていなければ not-installed を返す
// - macOS 15 では、翻訳のセッションを SwiftUI の translationTask からしか作れない。
//   画面の外に小さな窓を置いてそこで動かす。アプリとしては前に出ない（accessory）
// - 止まったまま窓が残らないよう、行数に応じた時間で自分で終わる
import AppKit
import NaturalLanguage
import SwiftUI
import Translation

let target = Locale.Language(identifier: "ja")

struct Input: Decodable {
  let texts: [String]
}

struct Output: Encodable {
  let ok: Bool
  var texts: [String]? = nil
  var source: String? = nil
  var error: String? = nil
  var message: String? = nil
}

func finish(_ output: Output) -> Never {
  let data = (try? JSONEncoder().encode(output)) ?? Data(#"{"ok":false,"error":"failed"}"#.utf8)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
  exit(0)
}

func fail(_ error: String, source: String? = nil, message: String? = nil) -> Never {
  finish(Output(ok: false, source: source, error: error, message: message))
}

// 元の言語。短い文でぶれないよう、英語を少し優先する（訳したい文はほとんど英語）
func detectLanguage(_ text: String) -> NLLanguage? {
  let recognizer = NLLanguageRecognizer()
  recognizer.languageHints = [.english: 0.6, .japanese: 0.2]
  recognizer.processString(text)
  return recognizer.dominantLanguage
}

guard let input = try? JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile()) else {
  fail("failed", message: "入力を読めませんでした")
}
// 空の行は訳さずにそのまま返す
let targets = input.texts.indices.filter { !input.texts[$0].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
if targets.isEmpty { finish(Output(ok: true, texts: input.texts, source: nil)) }

guard let detected = detectLanguage(targets.map { input.texts[$0] }.joined(separator: "\n")) else {
  fail("unsupported", message: "言語を判定できませんでした")
}
let sourceId = detected.rawValue
if detected == .japanese { fail("same-language", source: sourceId) }
let source = Locale.Language(identifier: sourceId)
// 1 行に 50 ミリ秒ほどかかる（2026-10 に macOS 26 で測った。200 行で 9 秒）ので、行数に合わせて待つ
let timeoutSeconds = 20.0 + 0.1 * Double(targets.count)

struct Runner: View {
  let texts: [String]
  let targets: [Int]
  let source: Locale.Language

  var body: some View {
    Color.clear.translationTask(TranslationSession.Configuration(source: source, target: target)) { session in
      do {
        let requests = targets.map { TranslationSession.Request(sourceText: texts[$0], clientIdentifier: String($0)) }
        var result = texts
        for response in try await session.translations(from: requests) {
          if let id = response.clientIdentifier, let i = Int(id) { result[i] = response.targetText }
        }
        finish(Output(ok: true, texts: result, source: source.minimalIdentifier))
      } catch {
        fail("failed", source: source.minimalIdentifier, message: error.localizedDescription)
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in
  switch await LanguageAvailability().status(from: source, to: target) {
  case .installed:
    let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1, height: 1), styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = NSHostingView(rootView: Runner(texts: input.texts, targets: targets, source: source))
    window.orderFrontRegardless()
  case .supported:
    fail("not-installed", source: sourceId)
  default:
    fail("unsupported", source: sourceId)
  }
}
DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds) {
  fail("failed", source: sourceId, message: "時間内に訳し終わりませんでした")
}
app.run()
