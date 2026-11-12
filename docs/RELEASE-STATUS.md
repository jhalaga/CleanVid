# CleanVid 2.0.0 submission preparation

Prepared November 12, 2026. **Not submitted to either store.**

Chrome draft is now complete and saved. The dashboard enables **Submit for review**:
https://chrome.google.com/webstore/devconsole/408020c3-c13a-46d8-9fd2-9432afe39baf/ehepbfcjgmmpagkaedffoeaigkgldjgl/edit/listing

Edge package testing passes, but the Edge store draft is blocked on new developer enrollment. The owner confirmed Slovakia / Individual / Jozef Halaga. Country and account type have been selected; registration now requires the owner's address, phone number, and developer-agreement acceptance.

## Available materials

- Shared Chrome/Edge package: `dist/cleanvid-2.0.0.zip` (build with `npm run package`).
- SHA-256 checksum: `dist/cleanvid-2.0.0.zip.sha256`.
- Privacy policy: `docs/PRIVACY.md`, publicly available after pushing at https://github.com/jhalaga/CleanVid/blob/main/docs/PRIVACY.md.
- Store description, permission justifications, privacy-field notes and reviewer instructions: `docs/STORE-LISTING.md`.
- Store graphics: `docs/store-assets/01-compact-panel.png` and `02-settings.png`, both 1280 × 800; `03-small-promo.png`, 440 × 280; `icon128.png`, 128 × 128. Graphics use actual UI captures; caption detections in the panel graphic are explicitly labeled as mocked test data.
- The package includes the bundled Transformers Apache license and ONNX Runtime MIT license. Model downloads remain optional and separate from the package.

## Validation

- 34 unit tests pass.
- Static manifest/file-reference/syntax/icon checks pass.
- The most recent full UI smoke test passes (panel toggles, caption matching/muting/masking, options controls).
- Latest real-video GPU audio test passes: expected words detected at 6.29 s and 8.19 s, cached results displayed after reload without repeating covered windows.
- A second audio run exposed a test assertion error: it counted any newly analyzed audio near the start as redundant work, even if it filled an uncached gap. The assertion now compares new windows against the actual coverage recorded before reload, allowing 50 ms for logged timestamp rounding and range merging. No speech-recognition assertion was removed or relaxed.
- An earlier audio run missed an expected word. That result has not reproduced in the latest runs; its original cause remains unconfirmed. A passing example does not establish perfect detection or resolve all recall variability. This limitation is disclosed in the listing copy.
- Isolated Edge 157 GPU audio test passes: a fresh model installation completed, expected words were detected at 6.30 s and 8.22 s, and cached results appeared after reload without repeating covered windows. The test profile is separate from the user's browser and the Chrome test profile; use CLEANVID_AUDIO_TEST_PROFILE to select it.

## Dashboard blockers

Chrome dashboard: https://chrome.google.com/webstore/devconsole/408020c3-c13a-46d8-9fd2-9432afe39baf

Edge dashboard: https://partner.microsoft.com/en-us/dashboard/home

Native Edge control resumed successfully. Chrome accepted the 2.0.0 package and saved the English Tools listing, description, homepage/support links, icon, two screenshots, small promotional tile, permission explanations, privacy-policy URL, data-use disclosures, and reviewer setup instructions. Free/public/all-region distribution is saved. Data categories selected are authentication information (optional user-provided subtitle API key), web history (video IDs/titles), and website content. All three limited-use certifications are selected. A transient privacy-save error cleared on retry; the dashboard confirmed Item saved and enabled Submit for review. No review submission has been sent.

The Edge Add-ons program is not enrolled. Its registration form now has Slovakia / Individual selected, Jozef Halaga as publisher, the project repository as website, and English as preferred email language:
https://partner.microsoft.com/en-us/dashboard/account/exp/enrollnow/msedgeaddons

Registration has not been submitted and no agreement has been accepted. The required address and phone fields are blank. Microsoft states that customers can view the contact address in the developer profile; the owner needs to provide the intended address and review the developer agreement.

## Remaining before submission

1. Have the owner enter the intended developer-profile address and phone number, validate the address, and review/accept Microsoft's registration agreement.
2. Complete Edge enrollment, then create its draft with the tested package, prepared artwork, copy and disclosures.
3. Review the completed Chrome draft with the owner before submitting it for review. Chrome currently shows no missing required fields.
4. Continue investigating if the original intermittent missed-word case recurs. Detection is probabilistic and is not a guarantee.
5. Do not claim store approval or publication until the respective dashboard confirms that state.
