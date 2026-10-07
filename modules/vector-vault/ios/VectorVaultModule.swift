import ExpoModulesCore

/// Vector Vault's native primitives (docs/vault.md, "Native module"), typed for JavaScript in src/vault/native.ts.
/// Dispatch only: the work lives in VaultFiles.swift. M2 declares the cloud, incoming-file and background members here.
public final class VectorVaultModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VectorVault")

    // Archive data files and photos can be tens of megabytes: hashed off the JavaScript thread, 1 MiB at a time.
    AsyncFunction("hashFile") { (uri: String) throws -> String in
      try VaultFiles.hashFile(uri)
    }

    Function("hashText") { (text: String) -> String in
      VaultFiles.hashText(text)
    }

    Function("randomUUID") { () -> String in
      UUID().uuidString.lowercased()
    }

    // UIDevice is main-actor UIKit.
    AsyncFunction("deviceInfo") { () -> [String: Any] in
      VaultFiles.deviceInfo()
    }.runOnQueue(.main)

    Function("config") { () -> [String: Bool] in
      VaultFiles.config()
    }

    Function("setExcludedFromBackup") { (uri: String, excluded: Bool) throws in
      try VaultFiles.setExcludedFromBackup(uri, excluded)
    }
  }
}
