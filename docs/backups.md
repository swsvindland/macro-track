# Local backups

Open **Settings → Backup & restore**. Create a password of at least 10 characters and save the encrypted file using the phone's share sheet. A backup exists outside the app only after the user saves it to a destination. Macro Track has no password recovery or backup server. Choosing a cloud destination in the system share sheet uses that provider.

The file contains food entries with recorded local times and their nutrition snapshots, custom foods, favorites, saved meals, recipes, logging status, dated calorie/macro targets, goal revisions and program profiles, check-in history, and weight history. It excludes reference food catalogs, progress photos, body/height measurements, appearance preferences, health permissions and health synchronization mappings. Photos and body measurements already on the destination phone are left untouched. This is a nutrition-and-weight backup, not a complete archive of the inherited Body Track features.

To restore, enter the backup password, choose the file, review its date and record counts, then confirm replacement. Restore replaces the included categories; it does not merge them. Input is authenticated and structurally validated before database writes. The app saves, reads back and authenticates an encrypted copy of the current records before replacing anything. That recovery file uses the password entered for the incoming backup. Export the latest recovery copy from Settings; to undo a restore, select that exported file through the ordinary restore flow. Recovery copies on the phone are not protection against losing or uninstalling the app.

Database replacement and the pointer to the recovery file commit in one transaction. Failed validation, an unreadable recovery copy, or a failed transaction leaves current records intact. Recovery files from earlier restores are retained in the app's private documents directory; Settings exposes the latest one. Automatic retention management is not implemented yet.

Restore refuses to run while health sync is active and blocks new sync work during replacement. It switches health sync off, clears weight synchronization mappings and starts a fresh weight export namespace. It preserves mappings for unchanged body measurements. Restore does not modify Apple Health or Health Connect. Re-enabling sync can create duplicate weights, especially when the restored history already exists in the health service; reconciliation remains future work.

## Pre-migration copies

When an app update brings database migrations, the app first writes a consistent, self-contained copy of the personal database (`VACUUM INTO`, which includes the write-ahead log) to its private documents directory as `pre-migration-<n>.db`, where `n` is the schema version being replaced. It keeps the newest two. Fresh installs are skipped. The copy is unencrypted, like the live database, and is never part of an encrypted backup. If free storage cannot hold the copy and still leave the migration room to run, or the copy fails, the app removes any partial file, logs the failure and migrates anyway. A failed migration rolls back and shows an error screen with **Share database copy**, which shares that copy or makes a new one.

## File format

Version 1 uses AES-256-GCM authenticated encryption, a fresh 12-byte nonce and 16-byte salt from Expo Crypto, and PBKDF2-HMAC-SHA256 with 600,000 iterations. The algorithms come from the Noble libraries. Algorithm/version parameters are fixed and checked, and authenticated associated data binds the format. Only encrypted content is written to export/recovery files. Export files remain in OS-managed cache so receiving apps can finish reading them after the share sheet closes. Passwords are not stored. Derived-key buffers are cleared after use, though JavaScript cannot guarantee erasure of strings or all runtime copies.

The decrypted payload is versioned JSON with strict field validation, unique record IDs, bounded numbers/arrays, and consistent logging statuses. The current limit is 20 MiB of plaintext; hexadecimal encoding makes encrypted files roughly twice that size. File paths and SQL statements are never loaded from the payload. Catalog databases are not copied, keeping ordinary backups small.

The feature adds Expo DocumentPicker, Sharing and Crypto native modules. Rebuild a development client after installing dependencies (`pnpm ios` or `pnpm android`). A JavaScript refresh alone cannot add native modules. Physical-device share-sheet/provider workflows and large-backup performance still require QA.

## CSV export and erasure

Settings also exports readable food-entry and weight CSV files. Diary rows are ordered by date, then local time. A fasting day is one row with no food, zero nutrients and `day_status` `fasting`. Unknown fiber/sodium stay blank, food names are quoted, and formula-like strings are neutralized for spreadsheet use. CSV is unencrypted and is not a restore format. Use an encrypted backup for transfer or recovery.

Erasure requires a separate destructive confirmation. It clears all personal database tables, app-held recovery backups and pre-migration copies, inherited progress photos, and Macro Track export cache files while preserving reference food catalogs. It disables health sync. Deleted rows are overwritten, the database file is compacted (`VACUUM`) when storage allows, and its write-ahead log is emptied. It does not delete copies the user shared outside the app or records in Apple Health/Health Connect. Database deletion is transactional; file deletion cannot be part of that transaction. A file/storage failure can leave a partial file cleanup and is surfaced to the user for retry.
