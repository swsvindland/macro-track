import CryptoKit
import ExpoModulesCore
import Foundation
import UIKit

/// File, device and build-flag primitives behind VectorVaultModule (docs/vault.md, "Native module").
/// M2 adds networkInfo here.
enum VaultFiles {
  /// Read size for hashing: photos and NDJSON files stream through without being loaded whole.
  static let chunkSize = 1 << 20

  /// Lowercase hex SHA-256 of a file.
  static func hashFile(_ uri: String) throws -> String {
    let url = try fileURL(uri)
    let handle: FileHandle
    do {
      handle = try FileHandle(forReadingFrom: url)
    } catch {
      throw VaultFileError("Could not open \(url.lastPathComponent) to hash it.", error)
    }
    defer { try? handle.close() }
    var hasher = SHA256()
    do {
      while true {
        let data = try autoreleasepool { try handle.read(upToCount: chunkSize) }
        guard let data, !data.isEmpty else { break }
        hasher.update(data: data)
      }
    } catch {
      throw VaultFileError("Could not read \(url.lastPathComponent) to hash it.", error)
    }
    return hex(hasher.finalize())
  }

  /// Lowercase hex SHA-256 of the UTF-8 bytes.
  static func hashText(_ text: String) -> String {
    hex(SHA256.hash(data: Data(text.utf8)))
  }

  /// Device facts for archive manifests and clone detection. Call on the main queue.
  static func deviceInfo() -> [String: Any] {
    let device = UIDevice.current
    let info = Bundle.main.infoDictionary ?? [:]
    var fingerprint: Any = NSNull()
    // identifierForVendor is nil before the first unlock after a reboot and in some background launches.
    if let vendor = device.identifierForVendor?.uuidString {
      let bundleId = Bundle.main.bundleIdentifier ?? ""
      fingerprint = String(hashText("\(bundleId):\(vendor)").prefix(32))
    }
    return [
      "platform": "ios",
      "kind": device.userInterfaceIdiom == .pad ? "tablet" : "phone",
      "model": device.model,
      "osVersion": device.systemVersion,
      "appVersion": info["CFBundleShortVersionString"] as? String ?? "",
      "appBuild": info["CFBundleVersion"] as? String ?? "",
      "fingerprint": fingerprint,
    ]
  }

  /// Build flags plugins/with-vector-vault.js wrote into Info.plist at prebuild. JavaScript never reads them from
  /// the Expo config, which Metro and Xcode re-evaluate and which can disagree with the entitlements.
  static func config() -> [String: Bool] {
    let info = Bundle.main.infoDictionary ?? [:]
    return [
      "icloud": info["VectorVaultICloud"] as? Bool ?? false,
      "googleIos": (info["GIDClientID"] as? String).map { !$0.isEmpty } ?? false,
      "googleAndroid": false,
      "selftest": info["VectorVaultSelfTest"] as? Bool ?? false,
    ]
  }

  /// Keeps a file or folder (Documents/PendumVault: recovery sets, the crash journal, the device anchor) out of
  /// iCloud and computer backups. It must exist.
  static func setExcludedFromBackup(_ uri: String, _ excluded: Bool) throws {
    var url = try fileURL(uri)
    var values = URLResourceValues()
    values.isExcludedFromBackup = excluded
    do {
      try url.setResourceValues(values)
    } catch {
      throw VaultFileError("Could not change the backup setting of \(url.lastPathComponent).", error)
    }
  }

  /// A file:// URI as expo-file-system writes it, or an absolute path.
  static func fileURL(_ uri: String) throws -> URL {
    if uri.hasPrefix("/") {
      return URL(fileURLWithPath: uri)
    }
    guard let url = URL(string: uri), url.isFileURL else {
      throw VaultFileError("Not a file URI: \(uri)")
    }
    return url
  }

  static func hex<Bytes: Sequence>(_ bytes: Bytes) -> String where Bytes.Element == UInt8 {
    bytes.map { String(format: "%02x", $0) }.joined()
  }
}

/// Rejects with ERR_VAULT_FILE. Not a vault error code, so the engine reports the operation's own failure
/// (`exportFailed`, `restoreFailed`) through toVaultError in src/vault/errors.ts.
final class VaultFileError: Exception, @unchecked Sendable {
  init(_ detail: String, _ underlying: Error? = nil) {
    super.init(name: "VaultFileError", description: detail, code: "ERR_VAULT_FILE")
    cause = underlying
  }
}
