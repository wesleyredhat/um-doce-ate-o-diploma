// Lê o texto de um comprovante (foto ou PDF) com o OCR do próprio macOS (Vision), sem internet.
// Uso: ocr <arquivo>  →  imprime as linhas de texto encontradas.
// PDF com texto: vem direto do PDFKit; PDF escaneado: cada página vira imagem e passa pelo OCR.
// O bot compila uma vez (swiftc -O ocr.swift -o .ocr) e chama pelo receipts-reader.js.
import Foundation
import PDFKit
import Vision

func recognize(_ image: CGImage) -> [String] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["pt-BR", "en-US"]
  request.usesLanguageCorrection = false // valores e códigos não devem ser "corrigidos"
  try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}

func pageImage(_ page: PDFPage) -> CGImage? {
  let box = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2
  let width = Int(box.width * scale), height = Int(box.height * scale)
  guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("uso: ocr <arquivo>\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
var lines: [String] = []

// PDF começa com "%PDF"; o resto é tratado como imagem (abrir foto como PDF só gera erro no log).
let isPDF = (try? FileHandle(forReadingFrom: url).readData(ofLength: 4)) == Data("%PDF".utf8)
if isPDF, let pdf = PDFDocument(url: url) {
  let text = pdf.string ?? ""
  if text.trimmingCharacters(in: .whitespacesAndNewlines).count > 20 {
    lines = text.components(separatedBy: .newlines)
  } else {
    for i in 0..<min(pdf.pageCount, 3) { if let page = pdf.page(at: i), let img = pageImage(page) { lines += recognize(img) } }
  }
} else if let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
  lines = recognize(img)
} else {
  FileHandle.standardError.write("arquivo não reconhecido\n".data(using: .utf8)!)
  exit(1)
}
print(lines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: "\n"))
