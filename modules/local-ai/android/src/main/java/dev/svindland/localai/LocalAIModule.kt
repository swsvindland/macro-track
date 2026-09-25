package dev.svindland.localai

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Thin bridge to Gemini Nano through ML Kit's Prompt API. Prompts live in JavaScript so both
 * platforms share them; AICore runs the model on the phone, so nothing is sent to a server.
 */
class LocalAIModule : Module() {
  private var client: GenerativeModel? = null
  private val model: GenerativeModel
    get() = client ?: Generation.getClient().also { client = it }

  override fun definition() = ModuleDefinition {
    Name("LocalAI")

    AsyncFunction("getStatus") Coroutine { -> status() }

    AsyncFunction("download") Coroutine { ->
      try {
        model.download().collect { progress ->
          if (progress is DownloadStatus.DownloadFailed) throw progress.e
        }
      } catch (e: Exception) {
        throw classify(e)
      }
    }

    AsyncFunction("prewarm") Coroutine { ->
      runCatching { if (model.checkStatus() == FeatureStatus.AVAILABLE) model.warmup() }
      Unit
    }

    AsyncFunction("generate") Coroutine {
        instructions: String, prompt: String, _: String, imageUri: String?, maxTokens: Int ->
      generate(instructions, prompt, imageUri, maxTokens)
    }

    OnDestroy {
      client?.close()
      client = null
    }
  }

  private suspend fun status(): Map<String, Any> {
    val result = mutableMapOf<String, Any>("engine" to "gemini-nano", "vision" to true)
    try {
      when (model.checkStatus()) {
        FeatureStatus.AVAILABLE -> result["state"] = "available"
        FeatureStatus.DOWNLOADABLE -> result["state"] = "downloadable"
        FeatureStatus.DOWNLOADING -> result["state"] = "downloading"
        else -> {
          result["state"] = "unavailable"
          result["reason"] = "device"
          result["vision"] = false
        }
      }
    } catch (e: Exception) {
      // Phones without AICore or a supported Gemini Nano land here.
      result["state"] = "unavailable"
      result["reason"] = "device"
      result["vision"] = false
      result["detail"] = e.message ?: ""
    }
    return result
  }

  private suspend fun generate(
    instructions: String,
    prompt: String,
    imageUri: String?,
    maxTokens: Int
  ): String {
    // The Prompt API has no dynamic schema, so the JSON format is described in the prompt text.
    val text = TextPart("$instructions\n\n$prompt")
    val limit = maxTokens.coerceIn(64, 1024)
    val request =
      if (imageUri.isNullOrEmpty()) {
        generateContentRequest(text) { configure(limit) }
      } else {
        generateContentRequest(ImagePart(loadImage(imageUri)), text) { configure(limit) }
      }
    try {
      val response = model.generateContent(request)
      return response.candidates.firstOrNull()?.text
        ?: throw CodedException("ERR_LOCAL_AI_FAILED", "The on-device model returned nothing.", null)
    } catch (e: CodedException) {
      throw e
    } catch (e: Exception) {
      throw classify(e)
    }
  }

  private fun com.google.mlkit.genai.prompt.GenerateContentRequest.Builder.configure(limit: Int) {
    // Deterministic decoding keeps the same photo producing the same draft.
    temperature = 0f
    topK = 1
    candidateCount = 1
    maxOutputTokens = limit
  }

  /** Photos can be 50 MP; the model only needs a modest, upright image. */
  private fun loadImage(uri: String): Bitmap {
    val parsed = Uri.parse(uri)
    val path = parsed.path
    if (parsed.scheme != "file" || path == null || !File(path).exists())
      throw CodedException("ERR_LOCAL_AI_INVALID_IMAGE", "This photo could not be read.", null)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P)
      throw CodedException("ERR_LOCAL_AI_NO_VISION", "Photo analysis needs Android 9 or later.", null)
    return try {
      ImageDecoder.decodeBitmap(ImageDecoder.createSource(File(path))) { decoder, info, _ ->
        val longest = maxOf(info.size.width, info.size.height)
        val scale = if (longest > MAX_SIDE) MAX_SIDE.toFloat() / longest else 1f
        decoder.setTargetSize(
          (info.size.width * scale).toInt().coerceAtLeast(1),
          (info.size.height * scale).toInt().coerceAtLeast(1)
        )
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
    } catch (e: Exception) {
      throw CodedException("ERR_LOCAL_AI_INVALID_IMAGE", "This photo could not be read.", e)
    }
  }

  private fun classify(error: Exception): CodedException {
    if (error is CodedException) return error
    val code =
      if (error is GenAiException)
        when (error.errorCode) {
          GenAiException.ErrorCode.BUSY -> "BUSY"
          GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> "BACKGROUND"
          GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> "QUOTA"
          GenAiException.ErrorCode.REQUEST_TOO_LARGE -> "TOO_LONG"
          GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> "DISK"
          else -> "FAILED"
        }
      else "FAILED"
    val message =
      when (code) {
        "BUSY" -> "The on-device model is busy. Try again in a moment."
        "BACKGROUND" -> "Keep Macro Track open while the photo is analyzed."
        "QUOTA" -> "The on-device model has reached today's limit for this app."
        "TOO_LONG" -> "The description is too long."
        "DISK" -> "There isn't enough free storage for the on-device model."
        else -> error.message ?: "The on-device model could not analyze this."
      }
    return CodedException("ERR_LOCAL_AI_$code", message, error)
  }

  private companion object {
    const val MAX_SIDE = 1024
  }
}
