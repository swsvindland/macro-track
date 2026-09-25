package dev.svindland.localai

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Thin bridge to Gemini Nano through ML Kit's Prompt API and to ML Kit text recognition.
 * Prompts and parsing live in JavaScript so both platforms share them; everything runs on the
 * phone, so nothing is sent to a server.
 */
class LocalAIModule : Module() {
  private var client: GenerativeModel? = null
  private val model: GenerativeModel
    get() = client ?: Generation.getClient().also { client = it }
  // The bundled Latin model works offline on every supported phone, without AICore.
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

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

    AsyncFunction("recognizeText") Coroutine { imageUri: String -> recognizeText(imageUri) }

    OnDestroy {
      client?.close()
      client = null
      recognizer.close()
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
        generateContentRequest(ImagePart(loadImage(imageUri, MAX_SIDE)), text) { configure(limit) }
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

  /**
   * Text lines as normalized boxes with a top-left origin, like Vision's on iOS. A label
   * photographed sideways is read again in the other orientations.
   */
  private suspend fun recognizeText(uri: String): List<Map<String, Any>> {
    val bitmap = loadImage(uri, OCR_SIDE)
    var best = emptyList<Map<String, Any>>()
    for (rotation in listOf(0, 90, 270)) {
      val text =
        try {
          suspendCancellableCoroutine<Text> { continuation ->
            recognizer
              .process(InputImage.fromBitmap(bitmap, rotation))
              .addOnSuccessListener { continuation.resume(it) }
              .addOnFailureListener { continuation.resumeWithException(it) }
          }
        } catch (e: Exception) {
          throw CodedException("ERR_LOCAL_AI_FAILED", "Text recognition failed on this photo.", e)
        }
      // With a rotation, ML Kit reports boxes in the upright (rotated) frame.
      val width = (if (rotation % 180 == 0) bitmap.width else bitmap.height).toDouble()
      val height = (if (rotation % 180 == 0) bitmap.height else bitmap.width).toDouble()
      val lines =
        text.textBlocks.flatMap { it.lines }.mapNotNull { line ->
          val box = line.boundingBox ?: return@mapNotNull null
          mapOf(
            "text" to line.text,
            "x" to box.left / width,
            "y" to box.top / height,
            "width" to box.width() / width,
            "height" to box.height() / height
          )
        }
      if (hits(lines) > hits(best)) best = lines
      if (hits(best) >= 4) break
    }
    return best
  }

  private fun hits(lines: List<Map<String, Any>>) =
    lines.count { LABEL_WORDS.containsMatchIn(it["text"] as String) }

  /** Photos can be 50 MP; the models only need a modest, upright image. */
  private fun loadImage(uri: String, maxSide: Int): Bitmap {
    val parsed = Uri.parse(uri)
    val path = parsed.path
    if (parsed.scheme != "file" || path == null || !File(path).exists())
      throw CodedException("ERR_LOCAL_AI_INVALID_IMAGE", "This photo could not be read.", null)
    try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
      val decoded =
        BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
          ?: throw IllegalArgumentException("Undecodable image")
      val degrees =
        when (
          ExifInterface(path)
            .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        ) {
          ExifInterface.ORIENTATION_ROTATE_90 -> 90f
          ExifInterface.ORIENTATION_ROTATE_180 -> 180f
          ExifInterface.ORIENTATION_ROTATE_270 -> 270f
          else -> 0f
        }
      val scale = minOf(1f, maxSide.toFloat() / maxOf(decoded.width, decoded.height))
      if (degrees == 0f && scale == 1f) return decoded
      val matrix = Matrix().apply {
        postScale(scale, scale)
        postRotate(degrees)
      }
      return Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
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
    const val OCR_SIDE = 2400
    val LABEL_WORDS = Regex("calor|total fat|protein|carb|sodium|serving", RegexOption.IGNORE_CASE)
  }
}
