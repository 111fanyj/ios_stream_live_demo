import Accelerate
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import Vision

private struct RemoteGrayscaleImage {
    let width: Int
    let height: Int
    let pixels: [UInt8]
}

private struct RemoteImageMatch {
    let point: AutomationPoint
    let score: Double
    let scaleMultiplier: Double
    let bounds: [String: Double]
}

private struct RemoteImageMatchPosition {
    let x: Int
    let y: Int
    let score: Double
}

private struct RemoteRecognizedText {
    let text: String
    let confidence: Float
    let point: AutomationPoint
    let bounds: [String: Double]
}

final class RemoteAutomationInspector {
    enum InspectorError: LocalizedError {
        case sessionInactive
        case unsupportedStepType(String)
        case missingTemplateData(String)
        case invalidTemplateData(String)

        var errorDescription: String? {
            switch self {
            case .sessionInactive:
                return "远程检查会话未激活"
            case .unsupportedStepType(let type):
                return "不支持的远程检查步骤类型: \(type)"
            case .missingTemplateData(let assetID):
                return "缺少图片模板数据: \(assetID)"
            case .invalidTemplateData(let assetID):
                return "图片模板数据无效: \(assetID)"
            }
        }
    }

    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private var cachedTemplates: [String: CGImage] = [:]
    private var activeSessionID: String?

    func start(sessionID: String) {
        activeSessionID = sessionID
        cachedTemplates.removeAll()
    }

    func stop(sessionID: String? = nil) {
        if let sessionID, let activeSessionID, sessionID != activeSessionID {
            return
        }

        activeSessionID = nil
        cachedTemplates.removeAll()
    }

    func evaluate(step: AutomationStep, sessionID: String, pixelBuffer: CVPixelBuffer) throws -> [String: Any] {
        guard activeSessionID == sessionID else {
            throw InspectorError.sessionInactive
        }

        switch step.type {
        case "waitForText", "loopUntilText":
            return [
                "itemType": step.type,
                "ocrCandidates": collectTextCandidates(pixelBuffer: pixelBuffer, preferredQueries: collectTextQueries(step: step))
            ]
        case "waitForImage", "loopUntilImage":
            var payload: [String: Any] = [
                "itemType": step.type
            ]
            if let match = try findBestImageMatch(step: step, pixelBuffer: pixelBuffer) {
                payload["bestImageMatch"] = [
                    "point": [
                        "x": match.point.x,
                        "y": match.point.y
                    ],
                    "score": match.score,
                    "scaleMultiplier": match.scaleMultiplier,
                    "bounds": match.bounds
                ]
            }
            return payload
        default:
            throw InspectorError.unsupportedStepType(step.type)
        }
    }

    func makeDebugOCRPayload(pixelBuffer: CVPixelBuffer, query: String?) -> [String: Any] {
        let normalizedQuery = (query ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let recognizedTexts = collectRecognizedTexts(
            pixelBuffer: pixelBuffer,
            preferredQueries: normalizedQuery.isEmpty ? [] : [normalizedQuery]
        )
        let candidates = recognizedTexts.map { text in
            let matched = normalizedQuery.isEmpty ? true : matchesText(text.text, query: normalizedQuery)
            return [
                "text": text.text,
                "confidence": text.confidence,
                "point": [
                    "x": text.point.x,
                    "y": text.point.y
                ],
                "bounds": text.bounds,
                "matched": matched
            ] as [String : Any]
        }
        let matchedCandidates = candidates.filter { ($0["matched"] as? Bool) == true }

        return [
            "query": normalizedQuery,
            "ocrCandidates": candidates,
            "matchedCandidates": matchedCandidates,
            "matchedCount": matchedCandidates.count
        ]
    }

    private func collectTextCandidates(pixelBuffer: CVPixelBuffer, preferredQueries: [String]) -> [[String: Any]] {
        var candidates: [[String: Any]] = []
        for text in collectRecognizedTexts(pixelBuffer: pixelBuffer, preferredQueries: preferredQueries) {
            candidates.append([
                "text": text.text,
                "confidence": text.confidence,
                "point": [
                    "x": text.point.x,
                    "y": text.point.y
                ],
                "bounds": text.bounds
            ])
        }

        return candidates
    }

    private func collectRecognizedTexts(pixelBuffer: CVPixelBuffer, preferredQueries: [String]) -> [RemoteRecognizedText] {
        let sourceWidth = Double(max(1, CVPixelBufferGetWidth(pixelBuffer)))
        let sourceHeight = Double(max(1, CVPixelBufferGetHeight(pixelBuffer)))
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        let customWords = preferredQueries.compactMap(normalizedMatchText)
        if !customWords.isEmpty {
            request.customWords = customWords
        }

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up)
        do {
            try handler.perform([request])
        } catch {
            return []
        }

        var results: [RemoteRecognizedText] = []
        for observation in request.results ?? [] {
            let bounds = pixelBounds(from: observation.boundingBox, imageWidth: sourceWidth, imageHeight: sourceHeight)
            let point = AutomationPoint(
                x: observation.boundingBox.midX * sourceWidth,
                y: (1.0 - observation.boundingBox.midY) * sourceHeight
            )
            for candidate in observation.topCandidates(3) {
                results.append(RemoteRecognizedText(
                    text: candidate.string,
                    confidence: candidate.confidence,
                    point: point,
                    bounds: bounds
                ))
            }
        }

        return results
    }

    private func pixelBounds(from rect: CGRect, imageWidth: Double, imageHeight: Double) -> [String: Double] {
        [
            "x": rect.minX * imageWidth,
            "y": (1.0 - rect.maxY) * imageHeight,
            "width": rect.width * imageWidth,
            "height": rect.height * imageHeight
        ]
    }

    private func matchesText(_ text: String, query: String) -> Bool {
        guard let normalizedText = normalizedMatchText(text),
              let normalizedQuery = normalizedMatchText(query),
              !normalizedText.isEmpty,
              !normalizedQuery.isEmpty
        else {
            return false
        }

        return normalizedText.contains(normalizedQuery)
    }

    private func normalizedMatchText(_ text: String?) -> String? {
        guard let text else {
            return nil
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        return trimmed
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "zh_Hans_CN"))
            .replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
    }

    private func collectTextQueries(step: AutomationStep) -> [String] {
        var queries: [String] = []
        if let query = step.query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            queries.append(query)
        }

        for query in step.queryOptions ?? [] {
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || queries.contains(trimmed) {
                continue
            }
            queries.append(trimmed)
        }

        return queries
    }

    private func findBestImageMatch(step: AutomationStep, pixelBuffer: CVPixelBuffer) throws -> RemoteImageMatch? {
        guard let templateImage = try templateImage(for: step),
              let frameImage = makeCGImage(from: pixelBuffer)
        else {
            return nil
        }

        let sourceWidth = max(1, CVPixelBufferGetWidth(pixelBuffer))
        let sourceHeight = max(1, CVPixelBufferGetHeight(pixelBuffer))
        let frameLongEdge = max(sourceWidth, sourceHeight)
        let scale = min(1.0, 384.0 / Double(frameLongEdge))
        let frameWidth = max(2, Int(Double(sourceWidth) * scale))
        let frameHeight = max(2, Int(Double(sourceHeight) * scale))

        guard let frame = makeGrayscale(from: frameImage, width: frameWidth, height: frameHeight)
        else {
            return nil
        }

        var bestMatch: RemoteImageMatch?
        for candidate in templateCandidates(
            templateImage: templateImage,
            baseScale: scale,
            frameWidth: frame.width,
            frameHeight: frame.height
        ) {
            guard let template = makeGrayscale(
                from: templateImage,
                width: candidate.width,
                height: candidate.height
            ) else {
                continue
            }

            let regionX = step.region?.x ?? 0
            let regionY = step.region?.y ?? 0
            let regionWidth = step.region?.width ?? Double(sourceWidth)
            let regionHeight = step.region?.height ?? Double(sourceHeight)
            let minX = Int((regionX / Double(sourceWidth)) * Double(frame.width))
            let minY = Int((regionY / Double(sourceHeight)) * Double(frame.height))
            let maxX = Int(((regionX + regionWidth) / Double(sourceWidth)) * Double(frame.width)) - template.width
            let maxY = Int(((regionY + regionHeight) / Double(sourceHeight)) * Double(frame.height)) - template.height

            guard let bestPosition = findBestMatchPosition(
                frame: frame,
                template: template,
                minX: minX,
                minY: minY,
                maxX: maxX,
                maxY: maxY
            ) else {
                continue
            }

            let centerX = ((Double(bestPosition.x) + Double(template.width) / 2.0) / Double(frame.width)) * Double(sourceWidth)
            let centerY = ((Double(bestPosition.y) + Double(template.height) / 2.0) / Double(frame.height)) * Double(sourceHeight)
            let bounds: [String: Double] = [
                "x": (Double(bestPosition.x) / Double(frame.width)) * Double(sourceWidth),
                "y": (Double(bestPosition.y) / Double(frame.height)) * Double(sourceHeight),
                "width": (Double(template.width) / Double(frame.width)) * Double(sourceWidth),
                "height": (Double(template.height) / Double(frame.height)) * Double(sourceHeight)
            ]
            let match = RemoteImageMatch(
                point: AutomationPoint(x: centerX, y: centerY),
                score: bestPosition.score,
                scaleMultiplier: candidate.scaleMultiplier,
                bounds: bounds
            )
            if bestMatch == nil || match.score > bestMatch!.score {
                bestMatch = match
            }
        }

        return bestMatch
    }

    private func templateCandidates(
        templateImage: CGImage,
        baseScale: Double,
        frameWidth: Int,
        frameHeight: Int
    ) -> [(width: Int, height: Int, scaleMultiplier: Double)] {
        let scaleMultipliers: [Double] = [0.85, 0.95, 1.0, 1.05, 1.15]
        var candidates: [(width: Int, height: Int, scaleMultiplier: Double)] = []
        var seenSizes = Set<String>()

        for scaleMultiplier in scaleMultipliers {
            let candidateScale = baseScale * scaleMultiplier
            let width = max(4, Int(Double(templateImage.width) * candidateScale))
            let height = max(4, Int(Double(templateImage.height) * candidateScale))
            guard width <= frameWidth, height <= frameHeight else {
                continue
            }

            let sizeKey = "\(width)x\(height)"
            guard !seenSizes.contains(sizeKey) else {
                continue
            }

            seenSizes.insert(sizeKey)
            candidates.append((width: width, height: height, scaleMultiplier: scaleMultiplier))
        }

        return candidates
    }

    private func findBestMatchPosition(
        frame: RemoteGrayscaleImage,
        template: RemoteGrayscaleImage,
        minX: Int,
        minY: Int,
        maxX: Int,
        maxY: Int
    ) -> RemoteImageMatchPosition? {
        let lowerX = max(0, minX)
        let lowerY = max(0, minY)
        let upperX = max(0, min(frame.width - template.width, maxX))
        let upperY = max(0, min(frame.height - template.height, maxY))
        guard lowerX <= upperX, lowerY <= upperY else {
            return nil
        }

        let coarseStep = imageScanStep(for: template)
        var best = RemoteImageMatchPosition(x: lowerX, y: lowerY, score: -Double.greatestFiniteMagnitude)
        for y in stride(from: lowerY, through: upperY, by: coarseStep) {
            for x in stride(from: lowerX, through: upperX, by: coarseStep) {
                let score = similarity(frame: frame, template: template, originX: x, originY: y)
                if score > best.score {
                    best = RemoteImageMatchPosition(x: x, y: y, score: score)
                }
            }
        }

        let refineRadius = max(1, coarseStep * 2)
        let refineMinX = max(lowerX, best.x - refineRadius)
        let refineMaxX = min(upperX, best.x + refineRadius)
        let refineMinY = max(lowerY, best.y - refineRadius)
        let refineMaxY = min(upperY, best.y + refineRadius)
        for y in refineMinY...refineMaxY {
            for x in refineMinX...refineMaxX {
                let score = similarity(frame: frame, template: template, originX: x, originY: y)
                if score > best.score {
                    best = RemoteImageMatchPosition(x: x, y: y, score: score)
                }
            }
        }

        return best
    }

    private func imageScanStep(for template: RemoteGrayscaleImage) -> Int {
        let minDimension = min(template.width, template.height)
        if minDimension <= 12 {
            return 1
        }
        if minDimension <= 24 {
            return 2
        }
        return 3
    }

    private func templateImage(for step: AutomationStep) throws -> CGImage? {
        let cacheKey = step.assetId ?? step.id
        if let cachedImage = cachedTemplates[cacheKey] {
            return cachedImage
        }

        guard let rawTemplate = step.imageDataURL, !rawTemplate.isEmpty else {
            throw InspectorError.missingTemplateData(step.assetId ?? step.id)
        }

        let base64: String
        if let commaIndex = rawTemplate.firstIndex(of: ",") {
            base64 = String(rawTemplate[rawTemplate.index(after: commaIndex)...])
        } else {
            base64 = rawTemplate
        }

        guard let data = Data(base64Encoded: base64),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw InspectorError.invalidTemplateData(step.assetId ?? step.id)
        }

        cachedTemplates[cacheKey] = image
        return image
    }

    private func similarity(frame: RemoteGrayscaleImage, template: RemoteGrayscaleImage, originX: Int, originY: Int) -> Double {
        var totalDifference: Float = 0
        for templateY in 0..<template.height {
            let frameOffset = (originY + templateY) * frame.width + originX
            let templateOffset = templateY * template.width

            let frameRow = frame.pixels[frameOffset..<(frameOffset + template.width)].map(Float.init)
            let templateRow = template.pixels[templateOffset..<(templateOffset + template.width)].map(Float.init)
            var difference = [Float](repeating: 0, count: template.width)
            var rowSum: Float = 0
            frameRow.withUnsafeBufferPointer { framePointer in
                templateRow.withUnsafeBufferPointer { templatePointer in
                    vDSP_vsub(
                        templatePointer.baseAddress!,
                        1,
                        framePointer.baseAddress!,
                        1,
                        &difference,
                        1,
                        vDSP_Length(template.width)
                    )
                }
            }

            vDSP_vabs(difference, 1, &difference, 1, vDSP_Length(template.width))
            vDSP_sve(difference, 1, &rowSum, vDSP_Length(template.width))
            totalDifference += rowSum
        }

        let maxDiff = Float(template.width * template.height * 255)
        guard maxDiff > 0 else {
            return 0
        }

        return 1.0 - Double(totalDifference / maxDiff)
    }

    private func makeCGImage(from pixelBuffer: CVPixelBuffer) -> CGImage? {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        return ciContext.createCGImage(image, from: image.extent)
    }

    private func makeGrayscale(from image: CGImage, width: Int, height: Int) -> RemoteGrayscaleImage? {
        var pixels = [UInt8](repeating: 0, count: width * height)
        let didDraw = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else {
                return false
            }

            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }

        guard didDraw else {
            return nil
        }

        return RemoteGrayscaleImage(width: width, height: height, pixels: pixels)
    }
}