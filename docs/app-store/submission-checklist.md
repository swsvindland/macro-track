# App Store submission

Prepared for VECTOR BODY 1.0.0, `dev.svindland.vector.body`; English (US). iPhone only (`supportsTablet: false`).

## Ready-to-enter content

Use `listing.json` or the generated `metadata/en-US/*.txt` files. Promotional text is separate from the description. The first release does not need What's New; use it for future versions. Suggested primary category: Health & Fitness. No secondary category is needed.

## Owner-supplied details

- Public support URL and privacy-policy URL; optional marketing URL.
- Copyright year and actual rights-holder name.
- Review contact name, email and phone.
- Price, territories, release timing and content-rights declaration.
- Applicable trader/business disclosures in App Store Connect.

## Privacy and age rating

Local-only processing is distinct from collection transmitted off the device. The reviewed app source has no account, analytics or advertising implementation. “Data Not Collected” is a candidate privacy-label answer only after checking the final binary, SDK behavior and Apple's collection definition. Do not mark health data as collected merely because it is stored locally, and do not assert the label is verified from this source review alone.

Complete Apple's current age-rating questionnaire from the actual build. Health/fitness references and user-imported private images should be evaluated using the questionnaire definitions. Do not invent a numeric age rating. There is no public photo-sharing feed or user messaging in the reviewed implementation.

## Release validation

- Sync native configuration with app.json before the release build. The existing local capture build uses the older `com.bodytrack.app` identifier; it is not the distribution binary.
- Verify Apple Health permission handling and import/export on a physical iPhone, including edits and deletions.
- Verify photo selection, camera, persistence after restart and deletion.
- Confirm estimates and reference text are readable and correct in the final binary.
- Publish the completed privacy policy and support page; replace placeholders before submission.
- Review every screenshot against the submitted build; no developer errors or nonexistent controls.
- Screenshots target the 6.9-inch iPhone slot at 1320 × 2868 pixels, portrait PNG, opaque RGB. Confirm the current upload slot accepts these dimensions. iPad assets are not needed while tablet support is disabled.

References: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/ and https://developer.apple.com/app-store/app-privacy-details/ . These links are provided for submission-time verification, not as a claim of live verification during asset production.
