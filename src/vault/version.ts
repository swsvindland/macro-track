// Vector Vault versions (docs/vault.md, "Versions"). `vault-kit bump` rewrites VAULT_VERSION; `vault-kit gen` reads
// VAULT_VERSION and FORMAT_VERSION from their declarations below, so each stays on one line.

/** Version of the synced vault package: `src/vault/manifest.json` and every archive's `app.vault`. */
export const VAULT_VERSION = "1.0.3";

/** Archive format this vault writes (`manifest.formatVersion`). Changed only by a deliberate format change. */
export const FORMAT_VERSION = 2;

/** Oldest reader that can read what this vault writes (`manifest.minReaderVersion`). */
export const MIN_READER_VERSION = 2;

/** Newest format this vault reads: archives with a higher `minReaderVersion` are `newer`. */
export const READER_VERSION = 2;
