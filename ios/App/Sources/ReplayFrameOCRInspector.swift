import Foundation
import UIKit
import Vision

struct ReplayFrameOCRCandidate: Identifiable {
    let id = UUID()
    let text: String
    let confidence: Float
    let boundingBox: CGRect
    let isMatch: Bool
}

struct ReplayFrameOCRResult {
    let annotatedImage: UIImage
    let captureTimestamp: String
    let imageSize: CGSize
    let candidates: [ReplayFrameOCRCandidate]

    var matches: [ReplayFrameOCRCandidate] {
        candidates.filter(\.isMatch)
    }
}

enum ReplayFrameOCRError: LocalizedError {
    case missingSnapshot
    case unreadableSnapshot
    case invalidSnapshotImage
    case recognitionFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingSnapshot:
            return "还没有可用的 replay 最新截图，请先确保 Broadcast Extension 正在接收屏幕画面。"
        case .unreadableSnapshot:
            return "无法读取最新 replay 截图。"
        case .invalidSnapshotImage:
            return "最新 replay 截图格式无效。"
        case .recognitionFailed(let message):
            return "OCR 执行失败: \(message)"
        }
    }
}

enum ReplayFrameOCRInspector {
    static func inspectLatestFrame(query: String) throws -> ReplayFrameOCRResult {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedQuery = normalize(trimmedQuery)
        let (image, captureTimestamp) = try loadLatestSnapshot()

        guard let cgImage = image.cgImage else {
            throw ReplayFrameOCRError.invalidSnapshotImage
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["zh-Hans", "en-US"]

        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up)
        do {
            try handler.perform([request])
        } catch {
            throw ReplayFrameOCRError.recognitionFailed(error.localizedDescription)
        }

        let imageSize = image.size
        let candidates = (request.results ?? []).compactMap { observation -> ReplayFrameOCRCandidate? in
            guard let candidate = observation.topCandidates(1).first else {
                return nil
            }

            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                return nil
            }

            let isMatch = normalizedQuery.isEmpty || normalize(text).contains(normalizedQuery)
            return ReplayFrameOCRCandidate(
                text: text,
                confidence: candidate.confidence,
                boundingBox: imageRect(from: observation.boundingBox, imageSize: imageSize),
                isMatch: isMatch
            )
        }

        let highlights = normalizedQuery.isEmpty
            ? candidates
            : candidates.filter(\.isMatch)
        let annotatedImage = drawHighlights(on: image, highlights: highlights)

        return ReplayFrameOCRResult(
            annotatedImage: annotatedImage,
            captureTimestamp: captureTimestamp,
            imageSize: imageSize,
            candidates: candidates
        )
    }

    private static func loadLatestSnapshot() throws -> (UIImage, String) {
        guard let imageURL = StreamDefaults.latestReplayFrameURL() else {
            throw ReplayFrameOCRError.unreadableSnapshot
        }

        guard FileManager.default.fileExists(atPath: imageURL.path) else {
            throw ReplayFrameOCRError.missingSnapshot
        }

        let data: Data
        do {
            data = try Data(contentsOf: imageURL)
        } catch {
            throw ReplayFrameOCRError.unreadableSnapshot
        }

        guard let image = UIImage(data: data) else {
            throw ReplayFrameOCRError.invalidSnapshotImage
        }

        let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier)
        let timestamp = defaults?.string(forKey: StreamDefaults.latestReplayFrameUpdatedAtKey) ?? ""
        return (image, timestamp)
    }

    private static func normalize(_ text: String) -> String {
        text
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
            .replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
    }

    private static func imageRect(from normalizedRect: CGRect, imageSize: CGSize) -> CGRect {
        CGRect(
            x: normalizedRect.minX * imageSize.width,
            y: (1.0 - normalizedRect.maxY) * imageSize.height,
            width: normalizedRect.width * imageSize.width,
            height: normalizedRect.height * imageSize.height
        )
    }

    private static func drawHighlights(on image: UIImage, highlights: [ReplayFrameOCRCandidate]) -> UIImage {
        let rendererFormat = UIGraphicsImageRendererFormat.default()
        rendererFormat.scale = image.scale
        let renderer = UIGraphicsImageRenderer(size: image.size, format: rendererFormat)

        return renderer.image { context in
            image.draw(in: CGRect(origin: .zero, size: image.size))

            for candidate in highlights {
                let rect = candidate.boundingBox.integral.insetBy(dx: -2, dy: -2)
                let path = UIBezierPath(roundedRect: rect, cornerRadius: 10)
                UIColor.systemRed.setStroke()
                path.lineWidth = 4
                path.stroke()

                let label = candidate.text.count > 18 ? String(candidate.text.prefix(18)) + "…" : candidate.text
                let font = UIFont.systemFont(ofSize: max(14, min(22, image.size.width * 0.032)), weight: .semibold)
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: UIColor.white
                ]
                let textSize = (label as NSString).size(withAttributes: attributes)
                let labelWidth = min(image.size.width - rect.minX, textSize.width + 14)
                let labelOriginY = max(4, rect.minY - textSize.height - 12)
                let labelRect = CGRect(
                    x: rect.minX,
                    y: labelOriginY,
                    width: labelWidth,
                    height: textSize.height + 8
                )
                let labelPath = UIBezierPath(roundedRect: labelRect, cornerRadius: 8)
                UIColor.systemRed.withAlphaComponent(0.88).setFill()
                labelPath.fill()
                (label as NSString).draw(
                    in: CGRect(x: labelRect.minX + 7, y: labelRect.minY + 4, width: labelRect.width - 14, height: labelRect.height - 8),
                    withAttributes: attributes
                )
            }

            if highlights.isEmpty {
                let message = "未命中"
                let font = UIFont.systemFont(ofSize: max(16, min(24, image.size.width * 0.038)), weight: .semibold)
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: UIColor.white
                ]
                let textSize = (message as NSString).size(withAttributes: attributes)
                let rect = CGRect(x: 16, y: 16, width: textSize.width + 20, height: textSize.height + 12)
                UIColor.black.withAlphaComponent(0.7).setFill()
                UIBezierPath(roundedRect: rect, cornerRadius: 10).fill()
                (message as NSString).draw(
                    in: CGRect(x: rect.minX + 10, y: rect.minY + 6, width: rect.width - 20, height: rect.height - 12),
                    withAttributes: attributes
                )
            }
        }
    }
}