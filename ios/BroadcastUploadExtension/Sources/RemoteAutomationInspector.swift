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
        case "waitForText":
            return [
                "itemType": step.type,
                "ocrCandidates": collectTextCandidates(pixelBuffer: pixelBuffer)
            ]
        case "waitForImage":
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
                    "scaleMultiplier": match.scaleMultiplier
                ]
            }
            return payload
        default:
            throw InspectorError.unsupportedStepType(step.type)
        }
    }

    private func collectTextCandidates(pixelBuffer: CVPixelBuffer) -> [[String: Any]] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["zh-Hans", "en-US"]

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up)
        do {
            try handler.perform([request])
        } catch {
            return []
        }

        var candidates: [[String: Any]] = []
        for observation in request.results ?? [] {
            let point = AutomationPoint(
                x: observation.boundingBox.midX,
                y: 1.0 - observation.boundingBox.midY
            )
            for candidate in observation.topCandidates(3) {
                candidates.append([
                    "text": candidate.string,
                    "confidence": candidate.confidence,
                    "point": [
                        "x": point.x,
                        "y": point.y
                    ]
                ])
            }
        }

        return candidates
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
        let scale = min(1.0, 320.0 / Double(frameLongEdge))
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

            let scanStep = imageScanStep(for: template)
            let minX = Int((step.region?.x ?? 0) * Double(frame.width))
            let minY = Int((step.region?.y ?? 0) * Double(frame.height))
            let maxX = Int(((step.region?.x ?? 0) + (step.region?.width ?? 1)) * Double(frame.width)) - template.width
            let maxY = Int(((step.region?.y ?? 0) + (step.region?.height ?? 1)) * Double(frame.height)) - template.height

            var bestScore = -Double.greatestFiniteMagnitude
            var bestX = 0
            var bestY = 0
            for y in stride(from: max(0, minY), through: max(0, min(frame.height - template.height, maxY)), by: scanStep) {
                for x in stride(from: max(0, minX), through: max(0, min(frame.width - template.width, maxX)), by: scanStep) {
                    let score = similarity(frame: frame, template: template, originX: x, originY: y)
                    if score > bestScore {
                        bestScore = score
                        bestX = x
                        bestY = y
                    }
                }
            }

            guard bestScore > -Double.greatestFiniteMagnitude else {
                continue
            }

            let centerX = (Double(bestX) + Double(template.width) / 2.0) / Double(frame.width)
            let centerY = (Double(bestY) + Double(template.height) / 2.0) / Double(frame.height)
            let match = RemoteImageMatch(
                point: AutomationPoint(x: centerX, y: centerY),
                score: bestScore,
                scaleMultiplier: candidate.scaleMultiplier
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
        let scaleMultipliers: [Double] = [0.8, 0.9, 1.0, 1.1, 1.2]
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