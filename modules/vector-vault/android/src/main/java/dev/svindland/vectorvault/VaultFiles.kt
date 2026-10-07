package dev.svindland.vectorvault

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest

/**
 * File, device and build-flag primitives behind VectorVaultModule (docs/vault.md, "Native module").
 * M2 adds networkInfo here.
 */
object VaultFiles {
  /** Read size for hashing: photos and NDJSON files stream through without being loaded whole. */
  private const val CHUNK_SIZE = 1 shl 20
  private const val META_GOOGLE = "dev.svindland.vectorvault.GOOGLE"
  private const val META_SELFTEST = "dev.svindland.vectorvault.SELFTEST"

  /** Lowercase hex SHA-256 of a file (file:// or content:// URI, or an absolute path). */
  fun hashFile(context: Context, uri: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val name = Uri.parse(uri).lastPathSegment ?: uri
    try {
      open(context, uri).use { input ->
        val buffer = ByteArray(CHUNK_SIZE)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
    } catch (e: CodedException) {
      throw e
    } catch (e: Exception) {
      throw VaultFileException("Could not read $name to hash it.", e)
    }
    return hex(digest.digest())
  }

  /** Lowercase hex SHA-256 of the UTF-8 bytes. */
  fun hashText(text: String): String =
    hex(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))

  /** Device facts for archive manifests and clone detection. */
  fun deviceInfo(context: Context): Map<String, Any?> {
    val pkg = packageInfo(context)
    // ANDROID_ID can be null; a null fingerprint never counts as another device.
    val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    val fingerprint =
      androidId?.takeIf { it.isNotEmpty() }?.let { hashText("${context.packageName}:$it").take(32) }
    val tablet = context.resources.configuration.smallestScreenWidthDp >= 600
    return mapOf(
      "platform" to "android",
      "kind" to if (tablet) "tablet" else "phone",
      "model" to Build.MODEL,
      "osVersion" to Build.VERSION.RELEASE,
      "appVersion" to (pkg.versionName ?: ""),
      "appBuild" to versionCode(pkg).toString(),
      "fingerprint" to fingerprint,
    )
  }

  /**
   * Build flags plugins/with-vector-vault.js wrote into the manifest at prebuild. JavaScript never reads them from the
   * Expo config, which Metro and Gradle re-evaluate.
   */
  fun config(context: Context): Map<String, Boolean> {
    val meta = applicationInfo(context).metaData
    return mapOf(
      "icloud" to false,
      "googleIos" to false,
      "googleAndroid" to (meta?.getBoolean(META_GOOGLE, false) ?: false),
      "selftest" to (meta?.getBoolean(META_SELFTEST, false) ?: false),
    )
  }

  private fun open(context: Context, uri: String): InputStream {
    val parsed = Uri.parse(uri)
    return when (parsed.scheme) {
      null -> FileInputStream(File(uri))
      "file" -> FileInputStream(File(parsed.path ?: throw VaultFileException("Not a file URI: $uri")))
      "content" ->
        context.contentResolver.openInputStream(parsed)
          ?: throw VaultFileException("Could not open $uri.")
      else -> throw VaultFileException("Not a file URI: $uri")
    }
  }

  private fun packageInfo(context: Context): PackageInfo =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getPackageInfo(context.packageName, 0)
    }

  private fun applicationInfo(context: Context): ApplicationInfo =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getApplicationInfo(
        context.packageName,
        PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong())
      )
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    }

  private fun versionCode(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.longVersionCode
    } else {
      @Suppress("DEPRECATION")
      info.versionCode.toLong()
    }

  private fun hex(bytes: ByteArray): String =
    bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

/**
 * Rejects with ERR_VAULT_FILE. Not a vault error code, so the engine reports the operation's own failure
 * (`exportFailed`, `restoreFailed`) through toVaultError in src/vault/errors.ts.
 */
class VaultFileException(message: String, cause: Throwable? = null) :
  CodedException("ERR_VAULT_FILE", message, cause)
