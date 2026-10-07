# PENDUM MACROS privacy policy — draft for publication

Effective date: [publication date]
Operator: [legal person or company]
Privacy contact: [contact email]

PENDUM MACROS stores the food diary you keep (food entries with their nutrition, custom foods, favorites, saved meals, recipes, daily targets, goals and check-ins), the weight entries, height entries and body measurements you add, your preferences and any progress photos in the app's local storage on your device. You do not need an account. The developer does not operate an account service, a server or any other developer-hosted storage for these records, and does not receive them. Records leave your device only when you choose to: through Apple Health or Health Connect sync, or an export you save or share (described below).

## Food search, camera and on-device analysis

The food catalogs (USDA FoodData Central and Open Food Facts) are included in the app. Searching them, scanning a barcode and logging food do not send anything to the developer or to the catalog providers.

If you scan a barcode or a nutrition label, or log a meal from a photo, the app requests camera permission; you may also choose an image from your photo library. Images are analyzed on your device: nutrition labels with the phone's text recognition, meal photos and descriptions with the phone's own language model (Apple's on-device model on iPhone, Gemini Nano on Android). Images are deleted from the app's cache once they have been read; they are not stored with your diary and are not sent to the developer.

## Progress photos

If you add a progress photo, the app requests camera permission; you may also choose images from your photo library. Selected images are copied to the app's private document storage. You can delete saved photos in the app. Progress photos are not sent to Apple Health or Health Connect.

## Apple Health and Health Connect

Health integration is optional. With your authorization, the app writes the food you log to Apple Health or Health Connect as nutrition (calories, protein, carbohydrates, fat, fiber, sodium and the other nutrients a food lists), starting 30 days before you turned sync on; reads weight and height and writes the ones you enter; and writes recorded body-fat percentages and, in Apple Health, waist circumference. On iPhone, it also reads your date of birth and sex to fill in a new program. Calculated estimates and other measurements are not exported. You control Health permissions in iOS or in Health Connect. Apple's and Google's services and any other apps you authorize are subject to their respective privacy practices.

Disabling sync stops scheduled integration; it does not erase previously saved Health records. Imported records remain managed by their original source. Deleting an imported weight in PENDUM MACROS removes it from the app without deleting the source record. Deleting or editing a food entry, weight or measurement the app wrote updates or deletes its Health record at the next successful sync.

## Exports and restores

You can export your data from Settings › Backup › Export data. The export is a single file containing your food diary and nutrition targets, custom foods, favorites, saved meals, recipes, goals and check-ins, weight entries, height entries and body measurements, progress photos, app settings, the readings the app imported from Apple Health or Health Connect, and the bookkeeping the app uses to keep those readings in sync. It also contains readable spreadsheet (CSV) copies of your diary, weights and targets. The app creates the file on your device and hands it to the share sheet (or, on Android, the folder you pick); where the file goes from there is your choice.

Restoring a file (Settings › Backup › Restore from a file) replaces the records in the app with the file's contents. Before replacing anything, the app keeps a copy of the data it replaces on your device, so the restore can be undone; it keeps the copies of the last two restores. Restoring turns Health sync off until you turn it on again. Password-protected backup files made by earlier versions of the app can still be restored; the password you type is used only on your device to open the file and is not stored.

Export files are not encrypted by the app. Anyone who can open the file can read your records and photos, so keep exported files somewhere private. The app does not upload export files anywhere; the developer has no server for them, never receives a copy and cannot access them. If you save a file to a cloud service such as iCloud Drive or Google Drive, it is stored under that service's privacy policy.

## Retention and device backups

Records remain in local app storage until deleted. Settings › Erase all data deletes the app's records, settings, progress photos and the copies it keeps on your device; it does not delete files you exported or records in Apple Health or Health Connect. Exports you made remain wherever you saved them until you delete them. Operating-system backups may include app data depending on your device settings; the app's restore copies and working files are excluded from them. Removing the app may remove its local records and photos. Retention of operating-system backups is controlled by the operating system and your backup provider.

## Contact and changes

For questions about privacy, contact [contact email]. We will update this policy when the app's data practices change.

---

Publication checklist: replace all bracketed fields; confirm the release binary and third-party dependencies do not transmit analytics, diagnostics or other data to the developer or partners; update this policy to match any such services; host at a public HTTPS URL. This draft replaces the inherited VECTOR BODY text with PENDUM MACROS' own data practices and adds the export and restore sections (October 5, 2026). It is not yet a published policy. The app has no automatic cloud backup; if one is added later, this policy must describe it before that release.
