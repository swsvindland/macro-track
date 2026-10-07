// Vault errors (docs/vault.md, "Errors"). A leaf: it imports nothing, so every engine, cloud and UI module, and the
// app code that reaches the vault through leaf modules, can use it. Library code never throws user-visible English:
// the UI turns a code into copy (`errorText` in src/vault/ui/labels.ts).

/** Every code a vault operation can fail with, as a runtime list (string-table tests iterate it). */
export const VAULT_ERROR_CODES = [
  "cancelled",
  "busy",
  "healthBusy",
  "unsupported",
  "notArchive",
  "wrongApp",
  "newer",
  "unknownSchema",
  "corrupt",
  "invalidData",
  "insufficientSpace",
  "migrationPending",
  "exportFailed",
  "restoreFailed",
  "shareUnavailable",
  "legacyPasswordRequired",
  "legacyPasswordWrong",
  "legacyTooLarge",
  "icloudNoAccount",
  "icloudUnavailable",
  "icloudQuota",
  "icloudAccountChanged",
  "icloudTimeout",
  "googleNotConfigured",
  "googleReconnect",
  "googleCancelled",
  "googleQuota",
  "googleRateLimited",
  "peerNotReady",
  "network",
  "provider",
  "unknown",
] as const;

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

export interface VaultErrorInfo {
  detail?: string;
  bytes?: number;
  app?: string;
  cause?: unknown;
}

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly info: VaultErrorInfo;

  constructor(code: VaultErrorCode, info: VaultErrorInfo = {}) {
    super(code, { cause: info.cause });
    this.name = "VaultError";
    this.code = code;
    this.info = info;
  }
}

const codes: readonly string[] = VAULT_ERROR_CODES;

export function isVaultErrorCode(value: unknown): value is VaultErrorCode {
  return typeof value === "string" && codes.includes(value);
}

/**
 * Any thrown value as a VaultError: a VaultError passes through, an AbortError becomes `cancelled`, an error whose
 * `code` is already a vault code (a native CodedError, for instance) keeps it, and everything else becomes `fallback`.
 */
export function toVaultError(e: unknown, fallback: VaultErrorCode): VaultError {
  if (e instanceof VaultError) return e;
  if (e instanceof Error && e.name === "AbortError")
    return new VaultError("cancelled", { cause: e });
  const code = typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
  if (isVaultErrorCode(code)) return new VaultError(code, { cause: e });
  const detail = e instanceof Error ? e.message : String(e);
  return new VaultError(fallback, { detail, cause: e });
}

/**
 * The ONLY cancellation checkpoint the vault uses. Reads `aborted` alone: React Native's AbortSignal
 * (abort-controller@3) has no other member, and vault-kit check rejects the Node-only ones in vault code.
 */
export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VaultError("cancelled");
}
