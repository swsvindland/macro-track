import CoreGraphics
import ExpoModulesCore
import Foundation
import ImageIO
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Thin bridge to Apple's on-device model. Prompts and schemas live in JavaScript so both
/// platforms share them; this side only checks availability and runs one request.
/// Only `SystemLanguageModel` is used, never Private Cloud Compute, so nothing leaves the phone.
public final class LocalAIModule: Module {
  nonisolated(unsafe) static var warm: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("LocalAI")

    AsyncFunction("getStatus") { () async -> [String: Any] in
      LocalAIModule.status()
    }

    // Apple installs and updates its model with the system; there is nothing to download.
    AsyncFunction("download") { () async in }

    AsyncFunction("prewarm") { () async in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *), SystemLanguageModel.default.isAvailable {
        // Kept until the next request so the loaded model isn't released straight away.
        let session = LanguageModelSession(model: .default)
        session.prewarm()
        LocalAIModule.warm = session
      }
      #endif
    }

    AsyncFunction("generate") {
      (instructions: String, prompt: String, schema: String, imageUri: String?, maxTokens: Int) async throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        return try await LocalAIModule.generate(
          instructions: instructions, prompt: prompt, schema: schema, imageUri: imageUri, maxTokens: maxTokens)
      }
      #endif
      throw LocalAIError("unavailable", "On-device models need iOS 26 or later.")
    }
  }

  static func status() -> [String: Any] {
    var result: [String: Any] = ["engine": "apple", "state": "unavailable", "vision": false]
    #if canImport(FoundationModels)
    guard #available(iOS 26.0, *) else {
      result["reason"] = "os"
      return result
    }
    let model = SystemLanguageModel.default
    switch model.availability {
    case .available:
      result["state"] = "available"
      if #available(iOS 27.0, *) {
        result["vision"] = model.capabilities.contains(.vision)
      } else {
        result["reason"] = "os"
      }
    case .unavailable(let reason):
      switch reason {
      case .deviceNotEligible: result["reason"] = "device"
      case .appleIntelligenceNotEnabled: result["reason"] = "disabled"
      case .modelNotReady:
        result["state"] = "downloading"
        result["reason"] = "not-ready"
      @unknown default: result["reason"] = "unsupported"
      }
    }
    #else
    result["reason"] = "os"
    #endif
    return result
  }

  #if canImport(FoundationModels)
  @available(iOS 26.0, *)
  static func generate(
    instructions: String, prompt: String, schema: String, imageUri: String?, maxTokens: Int
  ) async throws -> String {
    let generationSchema: GenerationSchema
    do {
      generationSchema = try JSONDecoder().decode(GenerationSchema.self, from: Data(schema.utf8))
    } catch {
      throw LocalAIError("invalid-request", "The response format could not be read.")
    }
    let session = LanguageModelSession(model: .default, instructions: instructions)
    warm = nil
    // Greedy decoding keeps the same photo producing the same draft.
    let options = GenerationOptions(
      samplingMode: .greedy, maximumResponseTokens: max(64, min(maxTokens, 2048)))
    do {
      if let imageUri, !imageUri.isEmpty {
        guard #available(iOS 27.0, *), SystemLanguageModel.default.capabilities.contains(.vision)
        else {
          throw LocalAIError("no-vision", "Photo analysis needs iOS 27 with Apple Intelligence.")
        }
        let image = try loadImage(imageUri)
        let response = try await session.respond(schema: generationSchema, options: options) {
          Attachment(image)
          prompt
        }
        return response.content.jsonString
      }
      let response = try await session.respond(to: prompt, schema: generationSchema, options: options)
      return response.content.jsonString
    } catch let error as LocalAIError {
      throw error
    } catch {
      throw classify(error)
    }
  }

  /// Photos can be 48 MP; the model only needs a modest, upright image.
  static func loadImage(_ uri: String) throws -> CGImage {
    guard let url = URL(string: uri), url.isFileURL,
      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 1280,
        ] as CFDictionary)
    else { throw LocalAIError("invalid-image", "This photo could not be read.") }
    return image
  }

  @available(iOS 26.0, *)
  static func classify(_ error: Error) -> LocalAIError {
    if #available(iOS 27.0, *), let error = error as? LanguageModelError {
      switch error {
      case .rateLimited: return LocalAIError("busy", "The on-device model is busy. Try again in a moment.")
      case .guardrailViolation, .refusal:
        return LocalAIError("refused", "The on-device model declined this request.")
      case .contextSizeExceeded: return LocalAIError("too-long", "The description is too long.")
      case .unsupportedLanguageOrLocale:
        return LocalAIError("language", "The on-device model does not support this language yet.")
      case .timeout: return LocalAIError("busy", "The on-device model took too long. Try again.")
      default: return LocalAIError("failed", error.localizedDescription)
      }
    }
    if let error = error as? LanguageModelSession.GenerationError {
      switch error {
      case .rateLimited, .concurrentRequests:
        return LocalAIError("busy", "The on-device model is busy. Try again in a moment.")
      case .guardrailViolation, .refusal:
        return LocalAIError("refused", "The on-device model declined this request.")
      case .exceededContextWindowSize: return LocalAIError("too-long", "The description is too long.")
      case .assetsUnavailable:
        return LocalAIError("not-ready", "Apple Intelligence is still getting ready. Try again later.")
      case .unsupportedLanguageOrLocale:
        return LocalAIError("language", "The on-device model does not support this language yet.")
      default: return LocalAIError("failed", error.localizedDescription)
      }
    }
    return LocalAIError("failed", error.localizedDescription)
  }
  #endif
}

/// Rejects with `code` so JavaScript can choose a retry or a clear explanation.
final class LocalAIError: Exception, @unchecked Sendable {
  private let detail: String

  init(_ failure: String, _ detail: String) {
    self.detail = detail
    super.init(
      name: "LocalAIError", description: detail,
      code: "ERR_LOCAL_AI_" + failure.uppercased().replacingOccurrences(of: "-", with: "_"))
  }

  override var reason: String { detail }
}
