// Pure label helpers for vault screens (docs/vault.md, "Strings"): the string key of a progress step, the sentence for
// an error and the noun for a device. No React and no app code, so tests/vault/strings.cjs runs them as they are and
// checks that every Step and every VaultErrorCode reaches an existing key.
import { isVaultErrorCode, type VaultErrorCode, type VaultErrorInfo } from "../errors";
import type { VaultT } from "../i18n";
import type { VaultStringKey } from "../strings";
import type { DeviceKind, DevicePlatform, Step } from "../types";

const stepKeys: Record<Step, VaultStringKey> = {
  snapshot: "stepSnapshot",
  data: "stepData",
  media: "stepMedia",
  csv: "stepCsv",
  zip: "stepZip",
  upload: "stepUpload",
  download: "stepDownload",
  verify: "stepVerify",
  scratch: "stepScratch",
  migrate: "stepMigrate",
  validate: "stepValidate",
  recovery: "stepRecovery",
  swap: "stepSwap",
  finish: "stepFinish",
};

/** The ProcessLine label of a progress step: `v(stepKey(progress.step))`. */
export function stepKey(step: Step): VaultStringKey {
  return stepKeys[step];
}

/**
 * Who started the failed run: "manual" for anything the person started (export, restore, Back up now, a cloud list or
 * download, handoff), "auto" for scheduled runs (launch, foreground, background, task).
 */
export type ErrorTrigger = "manual" | "auto";

/** A VaultError, or only its code (a stored status). `info.bytes` fills {size}; `info.app` fills {other}. */
export type VaultErrorLike = VaultErrorCode | { code: VaultErrorCode; info?: VaultErrorInfo };

/** Codes whose automatic wording promises a retry that only scheduled runs make; a manual run says "try again". */
type RetryCode = "network" | "provider" | "googleRateLimited";
const isRetry = (code: VaultErrorCode): code is RetryCode =>
  code === "network" || code === "provider" || code === "googleRateLimited";

/** Every code has an `error_<code>` key: a code without one fails tsc here. */
const errorKey = (code: VaultErrorCode): VaultStringKey => `error_${code}`;

/**
 * The sentence for an error: `error_<code>`, or `error_<code>_manual` when the person started the run and the code has
 * one. `cancelled` and `googleCancelled` render nothing (the person chose to stop). insufficientSpace without
 * `info.bytes` leaves the size out; wrongApp without `info.app` says the file is not this app's backup. A code this
 * version does not know (a status written by a newer one) reads as `unknown`.
 */
export function errorText(v: VaultT, error: VaultErrorLike, trigger: ErrorTrigger): string {
  const code = typeof error === "string" ? error : error.code;
  const info: VaultErrorInfo = (typeof error === "string" ? undefined : error.info) ?? {};
  if (!isVaultErrorCode(code)) return v("error_unknown");
  switch (code) {
    case "cancelled":
    case "googleCancelled":
      return "";
    case "insufficientSpace":
      return info.bytes
        ? v("error_insufficientSpace", { size: sizeText(v, info.bytes) })
        : v("error_insufficientSpaceNoSize");
    case "wrongApp":
      return info.app ? v("error_wrongApp", { other: info.app }) : v("error_notArchive");
  }
  if (trigger === "manual" && isRetry(code)) return v(`error_${code}_manual`);
  return v(errorKey(code));
}

/**
 * A byte count as the sizeMegabytes text ("12 MB"): decimal megabytes, as the iOS and Android storage screens count,
 * rounded up and at least 1, so "free up about {size}" is never too small.
 */
export function sizeText(v: VaultT, bytes: number): string {
  return v("sizeMegabytes", { n: Math.max(1, Math.ceil(bytes / 1e6)) });
}

/** "iPhone", "iPad", "Phone" or "Tablet": a standalone Meta item, never part of a sentence. */
export function deviceNoun(
  v: VaultT,
  device: { platform: DevicePlatform; kind: DeviceKind }
): string {
  if (device.platform === "ios") return v(device.kind === "tablet" ? "deviceIpad" : "deviceIphone");
  return v(device.kind === "tablet" ? "deviceTablet" : "devicePhone");
}
