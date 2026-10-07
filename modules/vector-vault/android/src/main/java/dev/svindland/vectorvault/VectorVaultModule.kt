package dev.svindland.vectorvault

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/**
 * Vector Vault's native primitives (docs/vault.md, "Native module"), typed for JavaScript in src/vault/native.ts.
 * Dispatch only: the work lives in VaultFiles.kt. M2 declares the network and Google members here, with no-ops for the
 * iOS-only ones.
 */
class VectorVaultModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("VectorVault")

    // Archive data files and photos can be tens of megabytes: hashed off the JavaScript thread, 1 MiB at a time.
    AsyncFunction("hashFile") { uri: String -> VaultFiles.hashFile(context, uri) }

    Function("hashText") { text: String -> VaultFiles.hashText(text) }

    Function<String>("randomUUID") { UUID.randomUUID().toString() }

    AsyncFunction<Map<String, Any?>>("deviceInfo") { VaultFiles.deviceInfo(context) }

    Function<Map<String, Boolean>>("config") { VaultFiles.config(context) }

    // Android keeps the vault folder out of OS backups through the backup rules the config plugin writes.
    Function("setExcludedFromBackup") { _: String, _: Boolean -> Unit }
  }
}
