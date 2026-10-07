// The vault's native module (modules/vector-vault) as typed JavaScript, with the per-process caches over it
// (docs/vault.md, "Native module"). Vault features are hidden where the module is absent: Expo Go, web, a build made
// before the vault's prebuild. Build flags come from here (Info.plist / AndroidManifest meta-data fixed at prebuild),
// never from Constants.expoConfig.extra, which Metro, Xcode and Gradle re-evaluate.
import { requireOptionalNativeModule } from "expo";

import { VaultError } from "./errors";
import type { DeviceInfo, VaultNativeConfig } from "./types";

/**
 * M1 members, on both platforms. M2 appends networkInfo, the iOS-only incoming-file, background-time and iCloud members
 * (optional: guard on Platform.OS) and the Google members.
 */
export interface VectorVaultNative {
  /** SHA-256 of a file (file:// URI), streamed natively in 1 MiB reads; lowercase hex. */
  hashFile(uri: string): Promise<string>;
  /** SHA-256 of the UTF-8 bytes; lowercase hex. */
  hashText(text: string): string;
  /** A random version 4 UUID, lowercase. */
  randomUUID(): string;
  /** Runs on the main queue on iOS (UIDevice); read it through loadDeviceInfo(). */
  deviceInfo(): Promise<DeviceInfo>;
  /** Build flags plugins/with-vector-vault.js wrote at prebuild; read them through nativeConfig(). */
  config(): VaultNativeConfig;
  /** iOS: isExcludedFromBackup on an existing file or folder. Android: no-op (the plugin's backup rules). */
  setExcludedFromBackup(uri: string, excluded: boolean): void;
}

export const native = requireOptionalNativeModule<VectorVaultNative>("VectorVault");

/** Vault features are hidden when the module is absent. */
export const vaultSupported = native != null;

/** The module, for code that runs only where `vaultSupported`; elsewhere it throws VaultError("unsupported"). */
export function vaultNative(): VectorVaultNative {
  if (!native) throw new VaultError("unsupported");
  return native;
}

const OFF: VaultNativeConfig = {
  icloud: false,
  googleIos: false,
  googleAndroid: false,
  selftest: false,
};

let flags: VaultNativeConfig | null = null;
let device: DeviceInfo | null = null;
let loading: Promise<DeviceInfo> | null = null;

/** The build flags, read once (they cannot change without a new build); all off without the module. */
export function nativeConfig(): VaultNativeConfig {
  if (!native) return OFF;
  flags ??= native.config();
  return flags;
}

/**
 * Device facts for manifests and clone detection, read once per process. ensureReady awaits it before any vault work;
 * concurrent callers share one native call, and a failed call is retried by the next caller.
 */
export async function loadDeviceInfo(): Promise<DeviceInfo> {
  if (device) return device;
  loading ??= vaultNative()
    .deviceInfo()
    .finally(() => {
      loading = null;
    });
  device = await loading;
  return device;
}

/** For render code: the facts loadDeviceInfo() read, or null before it resolved. */
export function deviceInfoCached(): DeviceInfo | null {
  return device;
}
