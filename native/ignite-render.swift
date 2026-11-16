// ignite-render: draw Ignite (Kindle Scribe) pages to PNG and read handwriting with Apple Vision.
//
// Input (stdin, JSON): { "jobs": [Job] }. Output (stdout, JSON): { "results": [Result] }, same order.
// Everything runs on this Mac: no network, no model downloads. Built by `npm run build:native` with
// `swiftc -O`. Coordinates are Ignite canonical page units (15624 x 20832, origin top-left);
// stroke radii are in Kindle raster pixels (1860 px page width), as Ignite's sealed profile defines.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct Background: Decodable { let path: String; let width: Int; let height: Int; let stride: Int }
struct Stroke: Decodable {
  let points: [Double] // x, y, radius triples
  /// false for ink the Mac generated (checkboxes, rules): drawn, but not fed to recognition.
  let ocr: Bool?
}
struct TextObject: Decodable { let x: Double; let y: Double; let width: Double; let fontSize: Double; let content: String }
struct OcrRequest: Decodable { let width: Int; let languages: [String] }
struct Job: Decodable {
  let pageWidth: Double
  let pageHeight: Double
  let rasterWidth: Double
  let strokes: [Stroke]
  let texts: [TextObject]?
  let background: Background?
  let png: String?
  let pngWidth: Int?
  let ocr: OcrRequest?
}
struct Input: Decodable {
  let jobs: [Job]
  /// Ignite's `default-sans-v1.ttf` (Source Sans 3). Without it text falls back to the system font.
  let fontPath: String?
}

struct Line: Encodable { let text: String; let confidence: Float; let x: Int; let y: Int; let w: Int; let h: Int }
struct Ocr: Encodable { let text: String; let lines: [Line] }
struct Result: Encodable { let ok: Bool; var error: String? = nil; var png: String? = nil; var ocr: Ocr? = nil }
struct Output: Encodable { let results: [Result] }

enum RenderError: Error, CustomStringConvertible {
  case context, image, write(String), background(String)
  var description: String {
    switch self {
    case .context: return "could not create bitmap context"
    case .image: return "could not create image"
    case .write(let p): return "could not write \(p)"
    case .background(let m): return "background: \(m)"
    }
  }
}

func render(_ job: Job, width: Int, includeBackground: Bool, includeTexts: Bool, skipPrinted: Bool = false) throws -> CGImage {
  let height = Int((Double(width) * job.pageHeight / job.pageWidth).rounded())
  guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
  else { throw RenderError.context }
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  ctx.interpolationQuality = .high

  if includeBackground, let bg = job.background {
    let data: Data
    do { data = try Data(contentsOf: URL(fileURLWithPath: bg.path)) } catch { throw RenderError.background("unreadable") }
    guard data.count >= bg.stride * bg.height, bg.stride >= bg.width,
          let provider = CGDataProvider(data: data as CFData),
          let image = CGImage(width: bg.width, height: bg.height, bitsPerComponent: 8, bitsPerPixel: 8,
                              bytesPerRow: bg.stride, space: CGColorSpaceCreateDeviceGray(),
                              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                              provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    else { throw RenderError.background("bad gray8 format") }
    // Drawn before the y-flip: CGImage row 0 lands at the top.
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  }

  ctx.translateBy(x: 0, y: CGFloat(height))
  ctx.scaleBy(x: 1, y: -1)
  let s = CGFloat(Double(width) / job.pageWidth)          // canonical -> output px
  let k = CGFloat(Double(width) / job.rasterWidth)        // Kindle raster px -> output px
  ctx.setStrokeColor(gray: 0, alpha: 1)
  ctx.setFillColor(gray: 0, alpha: 1)
  ctx.setLineCap(.round)
  ctx.setLineJoin(.round)

  for stroke in job.strokes {
    if skipPrinted && stroke.ocr == false { continue }
    let p = stroke.points
    let n = p.count / 3
    if n == 0 { continue }
    if n == 1 {
      let r = max(CGFloat(p[2]) * k, 0.5)
      ctx.fillEllipse(in: CGRect(x: CGFloat(p[0]) * s - r, y: CGFloat(p[1]) * s - r, width: 2 * r, height: 2 * r))
      continue
    }
    // Consecutive segments with the same radius share one path (round joins, no seams).
    var i = 0
    while i < n - 1 {
      let r = p[i * 3 + 2]
      ctx.beginPath()
      ctx.move(to: CGPoint(x: CGFloat(p[i * 3]) * s, y: CGFloat(p[i * 3 + 1]) * s))
      var j = i + 1
      while j < n {
        ctx.addLine(to: CGPoint(x: CGFloat(p[j * 3]) * s, y: CGFloat(p[j * 3 + 1]) * s))
        if j + 1 >= n || p[j * 3 + 2] != r { break }
        j += 1
      }
      ctx.setLineWidth(max(CGFloat(r) * 2 * k, 1))
      ctx.strokePath()
      i = j
    }
  }

  if includeTexts, let texts = job.texts, !texts.isEmpty {
    let ns = NSGraphicsContext(cgContext: ctx, flipped: true)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    for t in texts {
      let fs = CGFloat(t.fontSize) * s
      let font = TextFace.shared.font(size: max(fs, 4))
      let ascent = CTFontGetAscent(font)
      let lineHeight = TextFace.lineHeightEm * fs
      let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black, .kern: 0, .ligature: 0]
      ctx.saveGState()
      ctx.clip(to: CGRect(x: CGFloat(t.x) * s, y: 0, width: CGFloat(t.width) * s, height: CGFloat(height)))
      for (i, line) in TextFace.shared.wrap(t.content, fontSize: t.fontSize, width: t.width).enumerated() {
        // Kindle: baseline = top + i * 1.2em + half-leading + ascent.
        let baseline = CGFloat(t.y) * s + CGFloat(i) * lineHeight + (lineHeight - fs) / 2 + ascent
        NSAttributedString(string: line, attributes: attrs).draw(at: CGPoint(x: CGFloat(t.x) * s, y: baseline - ascent))
      }
      ctx.restoreGState()
    }
    NSGraphicsContext.restoreGraphicsState()
  }
  guard let image = ctx.makeImage() else { throw RenderError.image }
  return image
}

/// Text layout identical to the Kindle's (`scribe-app/src/text_paint.rs`): advances of the
/// `default-sans-v1` face measured per Unicode scalar, greedy wrap after spaces, 1.2 em lines.
final class TextFace {
  static let shared = TextFace()
  static let lineHeightEm: CGFloat = 1.2
  private var primary: CTFont? = nil
  private let fallback = CTFontCreateUIFontForLanguage(.system, 100, nil)!
  private var descriptor: CTFontDescriptor? = nil

  func load(path: String?) {
    guard let path, let descs = CTFontManagerCreateFontDescriptorsFromURL(URL(fileURLWithPath: path) as CFURL) as? [CTFontDescriptor],
          let d = descs.first else { return }
    descriptor = d
    primary = CTFontCreateWithFontDescriptor(d, 100, nil)
  }

  func font(size: CGFloat) -> CTFont {
    if let descriptor { return CTFontCreateWithFontDescriptor(descriptor, size, nil) }
    return CTFontCreateCopyWithAttributes(fallback, size, nil, nil)
  }

  private func advance100(_ scalar: Unicode.Scalar) -> CGFloat {
    let units = Array(String(scalar).utf16)
    var glyphs = [CGGlyph](repeating: 0, count: units.count)
    for f in [primary ?? fallback, fallback] {
      if CTFontGetGlyphsForCharacters(f, units, &glyphs, units.count), glyphs[0] != 0 {
        var adv = CGSize.zero
        CTFontGetAdvancesForGlyphs(f, .horizontal, glyphs, &adv, 1)
        return adv.width
      }
    }
    return 0
  }

  func wrap(_ content: String, fontSize: Double, width: Double) -> [String] {
    var out: [String] = []
    for para in content.split(separator: "\n", omittingEmptySubsequences: false) {
      let chars = Array(para.unicodeScalars)
      if chars.isEmpty { out.append(""); continue }
      var i = 0
      while i < chars.count {
        var end = i, w = 0.0
        var lastBreak: Int? = nil
        while end < chars.count {
          let ch = chars[end]
          let vs = (0xFE00...0xFE0F).contains(ch.value) || (0xE0100...0xE01EF).contains(ch.value)
          let adv = vs ? 0 : Double(advance100(ch)) / 100 * fontSize
          if w + adv > width && end > i { break }
          w += adv
          end += 1
          if ch == " " { lastBreak = end }
        }
        if end == i { end = i + 1 } else if end < chars.count, let b = lastBreak, b > i { end = b }
        var line = String.UnicodeScalarView()
        line.append(contentsOf: chars[i..<end])
        out.append(String(line))
        i = end
      }
    }
    return out
  }
}

func writePng(_ image: CGImage, to path: String) throws {
  let url = URL(fileURLWithPath: path)
  let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
  guard let dest = CGImageDestinationCreateWithURL(tmp as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { throw RenderError.write(path) }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { throw RenderError.write(path) }
  _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
}

func recognize(_ image: CGImage, job: Job, languages: [String]) throws -> Ocr {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  let supported = (try? request.supportedRecognitionLanguages()) ?? []
  let chosen = languages.filter { supported.contains($0) }
  if !chosen.isEmpty { request.recognitionLanguages = chosen }
  if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = chosen.count != 1 }
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  let observations = (request.results ?? []).compactMap { obs -> (VNRecognizedTextObservation, VNRecognizedText)? in
    guard let top = obs.topCandidates(1).first, !top.string.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    return (obs, top)
  }
  // Reading order: rows top to bottom (a row = vertical overlap), then left to right.
  let sorted = observations.sorted { a, b in
    let ay = 1 - a.0.boundingBox.midY, by = 1 - b.0.boundingBox.midY
    let tolerance = min(a.0.boundingBox.height, b.0.boundingBox.height) * 0.5
    if abs(ay - by) > tolerance { return ay < by }
    return a.0.boundingBox.minX < b.0.boundingBox.minX
  }
  let lines = sorted.map { obs, top -> Line in
    let b = obs.boundingBox
    return Line(text: top.string, confidence: top.confidence,
                x: Int(b.minX * job.pageWidth), y: Int((1 - b.maxY) * job.pageHeight),
                w: Int(b.width * job.pageWidth), h: Int(b.height * job.pageHeight))
  }
  return Ocr(text: lines.map(\.text).joined(separator: "\n"), lines: lines)
}

let input: Input
do {
  input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
} catch {
  FileHandle.standardError.write("ignite-render: bad input: \(error)\n".data(using: .utf8)!)
  exit(2)
}
TextFace.shared.load(path: input.fontPath)

var results: [Result] = []
for job in input.jobs {
  autoreleasepool {
    var result = Result(ok: true)
    do {
      if let png = job.png {
        let image = try render(job, width: job.pngWidth ?? 1240, includeBackground: true, includeTexts: true)
        try writePng(image, to: png)
        result.png = png
      }
      if let ocr = job.ocr {
        // Strokes only: paper lines and typed text would only add noise (typed text is exact already).
        let image = try render(job, width: ocr.width, includeBackground: false, includeTexts: false, skipPrinted: true)
        result.ocr = job.strokes.allSatisfy({ $0.ocr == false }) ? Ocr(text: "", lines: []) : try recognize(image, job: job, languages: ocr.languages)
      }
    } catch {
      result = Result(ok: false, error: String(describing: error))
    }
    results.append(result)
  }
}
let encoder = JSONEncoder()
FileHandle.standardOutput.write(try! encoder.encode(Output(results: results)))
