const fs = require("node:fs");
const path = require("node:path");

const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
} = require("expo/config-plugins");

const apps = require("../src/vault/apps.json");

// Vector Vault config plugin (docs/vault.md, "Build flags"). Synced from vector-design/vault: never edit it in a repo.
// Options are build flags only; per-app facts (archive type, database, media folders) come from src/vault/apps.json.
// The flags are fixed at prebuild into Info.plist and AndroidManifest meta-data, which the app reads through the
// native module (src/vault/native.ts). `extra.vectorVault` only documents them for `npx expo config`.
//
// M1: flags, extra, VectorVaultICloud (false until the iCloud entitlements land) and VectorVaultSelfTest, the exported
// archive type and the Android backup rules. M2 adds the document types, the Google keys, the iCloud entitlements with
// their finalized-mod assertions, and the intent filters, together with the incoming-file handler.

const OPTIONS = ["app", "icloud", "google", "selftest"];
const GOOGLE_OPTIONS = ["iosClientId", "android"];
const IOS_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const META_SELFTEST = "dev.svindland.vectorvault.SELFTEST";
const BACKUP_RULES = "vector_vault_backup_rules";
const EXTRACTION_RULES = "vector_vault_data_extraction_rules";

function fail(message) {
  throw new Error(`with-vector-vault: ${message}`);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function flag(value, name) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail(`${name} must be true or false`);
  return value;
}

/** "1" / "0" from eas.json build.<profile>.env or .env; unset or empty keeps the app.json option. */
function envFlag(value, name) {
  if (value === undefined || value === "") return undefined;
  if (value === "1") return true;
  if (value === "0") return false;
  return fail(`${name} must be "1" or "0", not ${JSON.stringify(value)}`);
}

/** The plugin options with the environment overrides applied (the environment wins), validated. */
function resolveFlags(options) {
  if (!isObject(options)) fail(`options must be an object such as { "app": "lift" }`);
  const unknown = Object.keys(options).filter((key) => !OPTIONS.includes(key));
  if (unknown.length) fail(`unknown option ${unknown.join(", ")} (allowed: ${OPTIONS.join(", ")})`);
  const id = options.app;
  if (typeof id !== "string" || !Object.hasOwn(apps, id))
    fail(`option "app" must be one of ${Object.keys(apps).join(", ")}`);
  const google = options.google ?? {};
  if (!isObject(google)) fail(`option "google" must be an object`);
  const unknownGoogle = Object.keys(google).filter((key) => !GOOGLE_OPTIONS.includes(key));
  if (unknownGoogle.length)
    fail(
      `unknown google option ${unknownGoogle.join(", ")} (allowed: ${GOOGLE_OPTIONS.join(", ")})`
    );
  if (google.iosClientId != null && typeof google.iosClientId !== "string")
    fail(`google.iosClientId must be a string or null`);

  const icloud =
    envFlag(process.env.VECTOR_VAULT_ICLOUD, "VECTOR_VAULT_ICLOUD") ??
    flag(options.icloud, "icloud");
  const iosClientId = process.env.VECTOR_VAULT_GOOGLE_IOS_CLIENT_ID || google.iosClientId || null;
  if (iosClientId !== null && !IOS_CLIENT_ID.test(iosClientId))
    fail(`google.iosClientId ${JSON.stringify(iosClientId)} is not an iOS OAuth client id`);
  const googleAndroid =
    envFlag(process.env.VECTOR_VAULT_GOOGLE_ANDROID, "VECTOR_VAULT_GOOGLE_ANDROID") ??
    flag(google.android, "google.android");
  const selftest = flag(options.selftest, "selftest");
  return { id, identity: apps[id], icloud, iosClientId, googleAndroid, selftest };
}

function withVaultInfoPlist(config, flags) {
  return withInfoPlist(config, (c) => {
    const plist = c.modResults;
    const a = flags.identity;
    if (plist.UIFileSharingEnabled === true)
      fail("UIFileSharingEnabled would expose Documents (SQLite, PendumVault) in the Files app");
    // The native flag JavaScript reads. Off until the vault adds the iCloud entitlements (M2), whatever the option.
    plist.VectorVaultICloud = false;
    plist.VectorVaultSelfTest = flags.selftest;
    // Exports are shared with this type. It conforms to public.data and public.content, not public.zip-archive, so
    // the Files app opens the app instead of offering to expand the archive.
    plist.UTExportedTypeDeclarations = [
      ...(plist.UTExportedTypeDeclarations ?? []).filter((t) => t.UTTypeIdentifier !== a.uti),
      {
        UTTypeIdentifier: a.uti,
        UTTypeDescription: a.typeName,
        UTTypeConformsTo: ["public.data", "public.content"],
        UTTypeTagSpecification: {
          "public.filename-extension": [a.extension],
          "public.mime-type": [a.mime],
        },
      },
    ];
    return c;
  });
}

function withVaultAndroidManifest(config, flags) {
  return withAndroidManifest(config, (c) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    // android:allowBackup keeps Expo's default (true); these rules only narrow what Auto Backup takes.
    application.$["android:fullBackupContent"] = `@xml/${BACKUP_RULES}`;
    application.$["android:dataExtractionRules"] = `@xml/${EXTRACTION_RULES}`;
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      META_SELFTEST,
      String(flags.selftest)
    );
    return c;
  });
}

const include = (file, extra = "") => `<include domain="file" path="${file}"${extra} />`;

/** The database and its journal (WAL file, or body's rollback journal for a crash-time backup). */
function databaseFiles(a) {
  const db = `SQLite/${a.database}`;
  return [db, `${db}${a.journal === "wal" ? "-wal" : "-journal"}`];
}

/** Android 12+: the database to the cloud; the database and the photos phone to phone. */
function extractionRules(a) {
  const files = databaseFiles(a).map((f) => include(f));
  const media = a.mediaDirs.map((d) => include(`${d}/`));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Generated by plugins/with-vector-vault.js from src/vault/apps.json. -->",
    "<data-extraction-rules>",
    "  <cloud-backup>",
    ...files.map((l) => `    ${l}`),
    "  </cloud-backup>",
    "  <device-transfer>",
    ...[...files, ...media].map((l) => `    ${l}`),
    "  </device-transfer>",
    "</data-extraction-rules>",
    "",
  ].join("\n");
}

/** Android 9-11 (cloud backup and device transfer): photos only phone to phone, never into the 25 MB cloud quota. */
function backupRules(a) {
  const files = databaseFiles(a).map((f) => include(f));
  const media = a.mediaDirs.map((d) => include(`${d}/`, ' requireFlags="deviceToDeviceTransfer"'));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Generated by plugins/with-vector-vault.js from src/vault/apps.json. -->",
    "<full-backup-content>",
    ...[...files, ...media].map((l) => `  ${l}`),
    "</full-backup-content>",
    "",
  ].join("\n");
}

/**
 * Once an include exists nothing else is backed up, so recovery sets, the crash journal, the device anchor
 * (Documents/PendumVault), pre-migration copies and caches stay out of Android backups.
 */
function withVaultBackupRules(config, flags) {
  return withDangerousMod(config, [
    "android",
    (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${EXTRACTION_RULES}.xml`), extractionRules(flags.identity));
      fs.writeFileSync(path.join(dir, `${BACKUP_RULES}.xml`), backupRules(flags.identity));
      return c;
    },
  ]);
}

function withVectorVault(config, options) {
  const flags = resolveFlags(options);
  if (flags.icloud || flags.iosClientId || flags.googleAndroid)
    console.warn(
      "with-vector-vault: iCloud and Google Drive take effect with the vault's cloud release (M2); this build keeps them off."
    );
  config.extra = {
    ...config.extra,
    vectorVault: {
      app: flags.id,
      icloud: flags.icloud,
      google: { ios: !!flags.iosClientId, android: flags.googleAndroid },
    },
  };
  config = withVaultInfoPlist(config, flags);
  config = withVaultAndroidManifest(config, flags);
  return withVaultBackupRules(config, flags);
}

module.exports = createRunOncePlugin(withVectorVault, "with-vector-vault", "1.0.0");
