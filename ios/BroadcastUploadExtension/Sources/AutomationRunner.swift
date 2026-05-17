import Accelerate
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import Vision

struct AutomationPoint: Codable {
    let x: Double
    let y: Double
}

struct AutomationRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    func contains(_ point: AutomationPoint) -> Bool {
        point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height
    }
}

struct AutomationTarget: Codable {
    let ref: String?
    let x: Double?
    let y: Double?
}

struct AutomationStep: Codable {
    let id: String
    let type: String
    let query: String?
    let match: String?
    let timeoutMs: Int?
    let pollIntervalMs: Int?
    let region: AutomationRect?
    let saveAs: String?
    let assetId: String?
    let threshold: Double?
    let target: AutomationTarget?
    let from: AutomationTarget?
    let to: AutomationTarget?
    let holdMs: Int?
    let durationMs: Int?
    let imageDataURL: String?
}

struct AutomationDocument: Codable {
    let schemaVersion: Int
    let packageId: String
    let revision: Int
    let name: String
    let steps: [AutomationStep]
}

private struct GrayscaleImage {
    let width: Int
    let height: Int
    let pixels: [UInt8]
}

final class AutomationRunner {
    enum RunnerError: LocalizedError {
        case noActivePackage
        case invalidPackagePath
        case missingAutomationJSON

        var errorDescription: String? {
            switch self {
            case .noActivePackage:
                return "没有 active automation package"
            case .invalidPackagePath:
                return "active automation package 路径无效"
            case .missingAutomationJSON:
                return "active automation package 缺少 automation.json"
            }
        }
    }

    private let document: AutomationDocument
    private let packageURL: URL
    private let eventHandler: ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "IOSStreamViewer.AutomationRunner")
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private var templates: [String: CGImage] = [:]
    private var stepIndex = 0
    private var stepStartedAt = Date()
    private var lastPollAt = Date.distantPast
    private var variables: [String: AutomationPoint] = [:]
    private var isProcessing = false
    private var isStopped = false

    var summary: String {
        "\(document.packageId) r\(document.revision) / \(document.steps.count) steps"
    }

    init(document: AutomationDocument, packageURL: URL, eventHandler: @escaping ([String: Any]) -> Void) {
        self.document = document
        self.packageURL = packageURL
        self.eventHandler = eventHandler
        preloadTemplates()
    }

    static func loadActive(eventHandler: @escaping ([String: Any]) -> Void) throws -> AutomationRunner {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier),
              let packagePath = defaults.string(forKey: StreamDefaults.automationActivePackagePathKey),
              !packagePath.isEmpty
        else {
            throw RunnerError.noActivePackage
        }

        let packageURL = URL(fileURLWithPath: packagePath, isDirectory: true)
        guard FileManager.default.fileExists(atPath: packageURL.path) else {
            throw RunnerError.invalidPackagePath
        }

        let automationURL = packageURL.appendingPathComponent("automation.json")
        guard FileManager.default.fileExists(atPath: automationURL.path) else {
            throw RunnerError.missingAutomationJSON
        }

        let data = try Data(contentsOf: automationURL)
        let document = try JSONDecoder().decode(AutomationDocument.self, from: data)
        return AutomationRunner(document: document, packageURL: packageURL, eventHandler: eventHandler)
    }

    func process(pixelBuffer: CVPixelBuffer, at now: Date) {
        queue.async { [weak self] in
            guard let self, !self.isProcessing, !self.isStopped else {
                return
            }

            self.isProcessing = true
            self.processCurrentStep(pixelBuffer: pixelBuffer, at: now)
            self.isProcessing = false
        }
    }

    private func preloadTemplates() {
        let imageDirectory = packageURL.appendingPathComponent("images", isDirectory: true)
        for step in document.steps where step.type == "waitForImage" {
            guard let assetId = step.assetId, templates[assetId] == nil else {
                continue
            }

            let imageURL = imageDirectory.appendingPathComponent("\(assetId).png")
            guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else {
                continue
            }

            templates[assetId] = image
        }
    }

    private func processCurrentStep(pixelBuffer: CVPixelBuffer, at now: Date) {
        guard stepIndex < document.steps.count else {
            return
        }

        while stepIndex < document.steps.count {
            let step = document.steps[stepIndex]
            switch step.type {
            case "tap":
                guard let point = resolve(step.target) else {
                    fail(step: step, message: "点击目标不存在")
                    return
                }
                emitTap(step: step, point: point)
                advance(to: now)
            case "drag":
                guard let from = resolve(step.from), let to = resolve(step.to) else {
                    fail(step: step, message: "拖拽目标不存在")
                    return
                }
                emitDrag(step: step, from: from, to: to)
                advance(to: now)
            default:
                processWaitStep(step, pixelBuffer: pixelBuffer, at: now)
                return
            }
        }

        eventHandler([
            "type": "complete",
            "packageId": document.packageId,
            "revision": document.revision,
            "message": "自动化流程完成"
        ])
    }

    private func processWaitStep(_ step: AutomationStep, pixelBuffer: CVPixelBuffer, at now: Date) {
        let elapsedMs = Int(now.timeIntervalSince(stepStartedAt) * 1000)
        let timeoutMs = step.timeoutMs ?? 10_000
        if elapsedMs > timeoutMs {
            fail(step: step, message: "等待超时")
            return
        }

        let pollIntervalMs = step.pollIntervalMs ?? 500
        guard Int(now.timeIntervalSince(lastPollAt) * 1000) >= pollIntervalMs else {
            return
        }
        lastPollAt = now

        let point: AutomationPoint?
        if step.type == "waitForText" {
            point = findText(step: step, pixelBuffer: pixelBuffer)
        } else if step.type == "waitForImage" {
            point = findImage(step: step, pixelBuffer: pixelBuffer)
        } else {
            fail(step: step, message: "未知步骤类型 \(step.type)")
            return
        }

        guard let point else {
            eventHandler([
                "type": "poll",
                "stepId": step.id,
                "message": "未命中"
            ])
            return
        }

        if let saveAs = step.saveAs, !saveAs.isEmpty {
            variables[saveAs] = point
        }

        eventHandler([
            "type": "match",
            "stepId": step.id,
            "point": ["x": point.x, "y": point.y],
            "message": step.type
        ])
        advance(to: now)
    }

    private func findText(step: AutomationStep, pixelBuffer: CVPixelBuffer) -> AutomationPoint? {
        guard let query = step.query, !query.isEmpty else {
            return nil
        }

        let sourceWidth = Double(max(1, CVPixelBufferGetWidth(pixelBuffer)))
        let sourceHeight = Double(max(1, CVPixelBufferGetHeight(pixelBuffer)))

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        request.customWords = [query]

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up)
        do {
            try handler.perform([request])
        } catch {
            return nil
        }

        for observation in request.results ?? [] {
            let candidates = observation.topCandidates(3)
            guard candidates.contains(where: { candidate in
                matches(text: candidate.string, query: query, mode: step.match ?? "contains")
            }) else {
                continue
            }

            let rect = observation.boundingBox
            let point = AutomationPoint(
                x: rect.midX * sourceWidth,
                y: (1.0 - rect.midY) * sourceHeight
            )
            if step.region?.contains(point) ?? true {
                return point
            }
        }

        return nil
    }

    private func matches(text: String, query: String, mode: String) -> Bool {
        let normalizedText = normalizeMatchText(text)
        let normalizedQuery = normalizeMatchText(query)
        switch mode {
        case "equals":
            return normalizedText == normalizedQuery
        default:
            return normalizedText.contains(normalizedQuery)
        }
    }

    private func normalizeMatchText(_ text: String) -> String {
        text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "zh_Hans_CN"))
            .replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
    }

    private func findImage(step: AutomationStep, pixelBuffer: CVPixelBuffer) -> AutomationPoint? {
        guard let assetId = step.assetId,
              let templateImage = templates[assetId],
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

        let threshold = step.threshold ?? 0.84
        var bestScore = -Double.greatestFiniteMagnitude
        var bestPoint: AutomationPoint?

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
            let regionX = step.region?.x ?? 0
            let regionY = step.region?.y ?? 0
            let regionWidth = step.region?.width ?? Double(sourceWidth)
            let regionHeight = step.region?.height ?? Double(sourceHeight)
            let minX = Int((regionX / Double(sourceWidth)) * Double(frame.width))
            let minY = Int((regionY / Double(sourceHeight)) * Double(frame.height))
            let maxX = Int(((regionX + regionWidth) / Double(sourceWidth)) * Double(frame.width)) - template.width
            let maxY = Int(((regionY + regionHeight) / Double(sourceHeight)) * Double(frame.height)) - template.height

            var candidateBestScore = -Double.greatestFiniteMagnitude
            var bestX = 0
            var bestY = 0
            for y in stride(from: max(0, minY), through: max(0, min(frame.height - template.height, maxY)), by: scanStep) {
                for x in stride(from: max(0, minX), through: max(0, min(frame.width - template.width, maxX)), by: scanStep) {
                    let score = similarity(frame: frame, template: template, originX: x, originY: y)
                    if score > candidateBestScore {
                        candidateBestScore = score
                        bestX = x
                        bestY = y
                    }
                }
            }

            guard candidateBestScore > bestScore else {
                continue
            }

            bestScore = candidateBestScore
            let templateHalfWidth = Double(template.width) / 2.0
            let templateHalfHeight = Double(template.height) / 2.0
            let centerXInScaledFrame = (Double(bestX) + templateHalfWidth) / Double(frame.width)
            let centerYInScaledFrame = (Double(bestY) + templateHalfHeight) / Double(frame.height)
            let centerX = centerXInScaledFrame * Double(sourceWidth)
            let centerY = centerYInScaledFrame * Double(sourceHeight)
            bestPoint = AutomationPoint(x: centerX, y: centerY)
        }

        guard bestScore >= threshold else {
            return nil
        }

        return bestPoint
    }

    private func templateCandidates(
        templateImage: CGImage,
        baseScale: Double,
        frameWidth: Int,
        frameHeight: Int
    ) -> [(width: Int, height: Int)] {
        let scaleMultipliers: [Double] = [0.8, 0.9, 1.0, 1.1, 1.2]
        var candidates: [(width: Int, height: Int)] = []
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
            candidates.append((width: width, height: height))
        }

        return candidates
    }

    private func imageScanStep(for template: GrayscaleImage) -> Int {
        let minDimension = min(template.width, template.height)
        if minDimension <= 12 {
            return 1
        }
        if minDimension <= 24 {
            return 2
        }
        return 3
    }

    private func similarity(frame: GrayscaleImage, template: GrayscaleImage, originX: Int, originY: Int) -> Double {
        var totalDifference: Float = 0
        for ty in 0..<template.height {
            let frameOffset = (originY + ty) * frame.width + originX
            let templateOffset = ty * template.width

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

    private func makeGrayscale(from image: CGImage, width: Int, height: Int) -> GrayscaleImage? {
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

        return GrayscaleImage(width: width, height: height, pixels: pixels)
    }

    private func resolve(_ target: AutomationTarget?) -> AutomationPoint? {
        guard let target else {
            return nil
        }

        if let ref = target.ref, let point = variables[ref] {
            return point
        }

        guard let x = target.x, let y = target.y else {
            return nil
        }

        return AutomationPoint(x: x, y: y)
    }

    private func emitTap(step: AutomationStep, point: AutomationPoint) {
        eventHandler([
            "type": "tap",
            "stepId": step.id,
            "point": ["x": point.x, "y": point.y],
            "message": "down/up"
        ])
    }

    private func emitDrag(step: AutomationStep, from: AutomationPoint, to: AutomationPoint) {
        eventHandler([
            "type": "drag",
            "stepId": step.id,
            "from": ["x": from.x, "y": from.y],
            "to": ["x": to.x, "y": to.y],
            "holdMs": step.holdMs ?? 120,
            "durationMs": step.durationMs ?? 450
        ])
    }

    private func advance(to now: Date) {
        stepIndex += 1
        stepStartedAt = now
        lastPollAt = .distantPast
    }

    private func fail(step: AutomationStep, message: String) {
        isStopped = true
        eventHandler([
            "type": "error",
            "stepId": step.id,
            "message": message
        ])
    }
}
