// Legacy v1 backups (docs/vault.md, "Restore"; spec §2.11). Before the vault, Pendum Lift and Pendum Macros wrote JSON
// backups — plain (`lift-track-backup`, `macro-track-backup`) or encrypted with a password (`…-encrypted-backup`) —
// and those still import. openArchive hands every file that is not a ZIP to the reader this module registers: the
// file's first 64 KiB decide whether it can be JSON at all (its first byte that is not white space is `{`); only
// then is the whole file read, within the adapter's size limit, and its `format` routes it. This app's plain format
// goes to the descriptor's legacy adapter (src/vault-legacy.ts), which parses it with the app's own v1 code; this
// app's encrypted format is decrypted first with the password the user typed (none yet: `legacyPasswordRequired`);
// another app's v1 format is `wrongApp`; anything else `notArchive`.
//
// The parsed backup then goes through the restore pipeline like any archive: the adapter writes it into a scratch
// database at the current schema level (scratch.ts), and the swap replaces the tables it declares, merges the Health
// links and applies its overrides (restore.ts). The entry points (ops.ts) import this module, which registers the
// reader with openArchive.
import { FileMode, type File } from "expo-file-system";

import { vaultApp } from "../app";
import apps from "../apps.json";
import { checkAborted, VaultError } from "../errors";
import type { AppId, VaultLegacy } from "../types";

import { setLegacyOpener, type LegacyOpen } from "./inspect";

/** How much of a file decides whether it can be a v1 backup at all; also where a damaged one names its format. */
export const SNIFF_BYTES = 64 * 1024;

/**
 * The v1 formats each app wrote: only Pendum Lift and Pendum Macros had JSON backups. This app's own formats come from
 * its descriptor (`legacy.formats`); this table names another app's file (`wrongApp`).
 */
export const V1_FORMATS: Readonly<Partial<Record<AppId, readonly string[]>>> = {
  lift: ["lift-track-backup", "lift-track-encrypted-backup"],
  macro: ["macro-track-backup", "macro-track-encrypted-backup"],
};

/** The largest v1 file either app could write: 20 MB of data, encrypted (hex doubles it), plus the envelope. */
const V1_MAX_BYTES = 20 * 1024 * 1024 * 2 + 4096;

/** JSON's white space: space, tab, line feed, carriage return. */
const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const OPEN_BRACE = 0x7b;
/** `"format": "<name>"` near the start of a file that does not parse (a v1 file cut short). */
const FORMAT_FIELD = /"format"\s*:\s*"([A-Za-z0-9-]{1,64})"/;

/** Whether the first byte of `file` that is not JSON white space, within its first 64 KiB, is `{`. */
export function startsLikeJson(file: File): boolean {
  const handle = file.open(FileMode.ReadOnly);
  try {
    const size = handle.size ?? 0;
    if (size <= 0) return false;
    for (const byte of handle.readBytes(Math.min(size, SNIFF_BYTES)))
      if (!SPACE.has(byte)) return byte === OPEN_BRACE;
    return false;
  } finally {
    handle.close();
  }
}

/** The app other than this one whose v1 backups use `format`. */
function otherApp(format: string): AppId | null {
  const ids = Object.keys(V1_FORMATS) as AppId[];
  return ids.find((id) => id !== vaultApp.id && V1_FORMATS[id]?.includes(format)) ?? null;
}

/**
 * The `format` and `version` of a v1 file's text. `json` is false when the text does not parse; the format is then
 * the one its start names, if any, so a damaged file of this app is `corrupt` rather than "not a backup".
 */
function header(text: string): { json: boolean; format: string | null; version: unknown } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      json: false,
      format: FORMAT_FIELD.exec(text.slice(0, SNIFF_BYTES))?.[1] ?? null,
      version: null,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { json: true, format: null, version: null };
  const { format, version } = value as { format?: unknown; version?: unknown };
  return { json: true, format: typeof format === "string" ? format : null, version };
}

/** The parsed backup with its date and preview counts; whatever the app's v1 code rejects is `corrupt`. */
function parsedBackup(adapter: VaultLegacy<unknown>, text: string): LegacyOpen {
  let parsed: unknown;
  try {
    parsed = adapter.parse(text);
  } catch (e) {
    throw new VaultError("corrupt", { detail: "legacy:parse", cause: e });
  }
  let created: string;
  let counts: LegacyOpen["counts"];
  try {
    created = adapter.createdAt(parsed);
    counts = adapter.counts(parsed);
  } catch (e) {
    throw new VaultError("corrupt", { detail: "legacy:summary", cause: e });
  }
  const time = Date.parse(created);
  if (!Number.isFinite(time)) throw new VaultError("corrupt", { detail: "legacy:createdAt" });
  // ISO, as the preview compares it with the newest live record (spec §3.5.2 newerLocalChanges).
  return { parsed, createdAt: new Date(time).toISOString(), counts };
}

/**
 * Reads a file that is not a ZIP as a v1 backup (the reader openArchive calls; `source` is its private copy).
 * Throws VaultError: `notArchive` (not a v1 backup of any app), `wrongApp` (another app's, with its brand name in
 * `info.app`), `legacyTooLarge` (over the adapter's limit), `legacyPasswordRequired` (encrypted, no password given),
 * `legacyPasswordWrong` (the password does not open it), `corrupt` (this app's format but damaged: not JSON, another
 * version, or rejected by the app's own checks), `cancelled`.
 */
export async function openLegacy(
  source: File,
  options: { password?: string; signal?: AbortSignal } = {}
): Promise<LegacyOpen> {
  const { signal } = options;
  checkAborted(signal);
  if (!startsLikeJson(source)) throw new VaultError("notArchive", { detail: "legacy:notJson" });
  const adapter = vaultApp.legacy ?? null;
  const size = source.size;
  if (size > (adapter?.maxBytes ?? V1_MAX_BYTES))
    throw adapter
      ? new VaultError("legacyTooLarge", { bytes: size })
      : new VaultError("notArchive", { detail: "legacy:size" });
  const text = await source.text();
  checkAborted(signal);

  const { json, format, version } = header(text);
  const own = adapter ? [adapter.formats.plain, adapter.formats.encrypted] : [];
  if (!adapter || format === null || !own.includes(format)) {
    const other = format === null ? null : otherApp(format);
    if (other)
      throw new VaultError("wrongApp", { app: apps[other].name, detail: `legacy:${other}` });
    throw new VaultError("notArchive", { detail: "legacy:format" });
  }
  // This app's v1 file from here on: only version 1 was ever written.
  if (!json) throw new VaultError("corrupt", { detail: "legacy:json" });
  if (version !== 1) throw new VaultError("corrupt", { detail: "legacy:version" });
  if (format === adapter.formats.plain) return parsedBackup(adapter, text);

  if (!options.password) throw new VaultError("legacyPasswordRequired");
  let plain: string;
  try {
    plain = await adapter.decrypt(text, options.password);
  } catch (e) {
    throw new VaultError("legacyPasswordWrong", { cause: e });
  }
  checkAborted(signal);
  return parsedBackup(adapter, plain);
}

setLegacyOpener(openLegacy);
