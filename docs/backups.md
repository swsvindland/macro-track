# Backups, export and restore

Backup, export and restore are provided by Vector Vault, the package shared by the Pendum apps. [docs/vault.md](vault.md) is the developer reference: the archive format, the descriptor contract, migrations, operations and tests. It is synced from `vector-design/vault` and must not be edited here. This page covers what is specific to Pendum Macros.

## In the app

**Settings → Backup**:

- **Export data** writes one `.pendummacros` file (a ZIP archive, not encrypted) and opens the share sheet; Android also offers **Save to device**. It holds every exported table, progress photos, readable `diary.csv`, `weight.csv` and `targets.csv` copies, and a `README.txt`.
- **Restore from a file** opens a `.pendummacros` file, or a v1 backup (below), shows what it contains next to what the phone holds, and replaces the app's data after confirmation.
- **Restore data from before …** appears after a restore over existing data: it puts back the copy the restore kept (the newest two are kept).

**Your data** still offers the separate CSV files and **Erase all data**.

## What a backup holds

`src/vault-app.ts` lists the exported tables: the food diary (`food_entries`, `diary_days`), `custom_foods`, `saved_foods`, `saved_meals`, `recipes`, `nutrition_targets`, `coaching_goals`, `check_ins`, `weight_entries`, `measurements`, `photos` with their files, the portable preferences (theme, units, language, diary layout, hide empty hours, count logged days) and the Health bookkeeping (`health_links` and the `installation`, `healthInstallations`, `weightSyncEpoch` and `healthFoodSince` preferences). The bundled food catalogs, the widget snapshot, Health permissions and other device state are never exported.

Every restore turns Health sync off. The Health links travel with the rows and are merged with this phone's own, so turning sync back on updates the samples already in Apple Health or Health Connect under their existing ids instead of writing them again. After a restore from another phone, food from the last 30 days is rewritten once; older food is left as it is.

## Backups from earlier versions (v1)

Before the vault, Settings had a **Backup and restore** panel that wrote password-encrypted `macro-track-…backup.json` files (format `macro-track-encrypted-backup` version 1, wrapping a `macro-track-backup` payload). They still restore through **Restore from a file**: the app asks for the backup's password, decrypts and validates the file with the original v1 code (`src/lib/backup-crypto.ts`, `src/lib/backup-data.ts`), and `src/vault-legacy.ts` writes its rows into the vault's restore pipeline. As with the v1 restore, only the ten tables a v1 file contains and the links of weights imported from Health are replaced; measurements, progress photos, preferences and the other Health links stay as they are. The phone's Health installation and weight namespace are kept, and samples this app wrote under any earlier installation are never imported again as outside readings.

The pre-restore copy the v1 panel kept in `Documents/MacroTrackBackups/` is offered as **Restore data from before …** until the next restore, which replaces it with the vault's own copy.

## Pre-migration copies

When an app update brings database migrations, the app first writes a consistent, self-contained copy of the personal database (`VACUUM INTO`, which includes the write-ahead log) to its private documents directory as `pre-migration-<n>.db`, where `n` is the schema version being replaced. It keeps the newest two. Fresh installs are skipped. The copy is unencrypted, like the live database. If free storage cannot hold the copy and still leave the migration room to run, or the copy fails, the app removes any partial file, logs the failure and migrates anyway. A failed migration rolls back and shows an error screen with **Share database copy**, which shares that copy or makes a new one.

## CSV export and erasure

Settings also exports readable food-entry, weight and targets CSV files. The weight file's `excluded` column marks readings ignored in the trend. The targets file has a row for each day the daily budget or goal changed, with any calorie shifting's higher days and how much more they get. Diary rows are ordered by date, then local time. A fasting day is one row with no food, zero nutrients and `day_status` `fasting`. Unknown fiber/sodium stay blank, food names are quoted, and formula-like strings are neutralized for spreadsheet use. CSV is not a restore format; use **Export data** for transfer or recovery.

Erasure requires a separate destructive confirmation. It clears all personal database tables, the app's restore copies and pre-migration copies, inherited progress photos, and export cache files while preserving reference food catalogs. It disables health sync but keeps the list of Health installations, so turning sync back on does not import the erased records again, and it turns automatic backup off; files already exported and backups in iCloud or Google Drive are kept. Deleted rows are overwritten, the database file is compacted (`VACUUM`) when storage allows, and its write-ahead log is emptied. It does not delete copies the user shared outside the app or records in Apple Health/Health Connect. Database deletion is transactional; file deletion cannot be part of that transaction. A file/storage failure can leave a partial file cleanup and is surfaced to the user for retry.
