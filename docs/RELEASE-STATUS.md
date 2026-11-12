# CleanVid 2.0.0 submission preparation

Prepared November 12, 2026. **Not submitted to either store.**

## Available materials

- Shared Chrome/Edge package: `dist/cleanvid-2.0.0.zip` (build with `npm run package`).
- SHA-256 checksum: `dist/cleanvid-2.0.0.zip.sha256`.
- Privacy policy: `docs/PRIVACY.md`, publicly available after pushing at https://github.com/jhalaga/CleanVid/blob/main/docs/PRIVACY.md.
- Store description, permission justifications, privacy-field notes and reviewer instructions: `docs/STORE-LISTING.md`.
- Store graphics: `docs/store-assets/01-compact-panel.png` and `02-settings.png`, both 1280 × 800; `icon128.png`, 128 × 128. Graphics use actual UI captures; caption detections in the panel graphic are explicitly labeled as mocked test data.
- The package includes the bundled Transformers Apache license and ONNX Runtime MIT license. Model downloads remain optional and separate from the package.

## Validation

- 34 unit tests pass.
- Static manifest/file-reference/syntax/icon checks pass.
- The most recent full UI smoke test passes (panel toggles, caption matching/muting/masking, options controls).
- Latest real-video GPU audio test passes: expected words detected at 6.29 s and 8.19 s, cached results displayed after reload without repeating covered windows.
- A second audio run exposed a test assertion error: it counted any newly analyzed audio near the start as redundant work, even if it filled an uncached gap. The assertion now compares new windows against the actual coverage recorded before reload, allowing 50 ms for logged timestamp rounding and range merging. No speech-recognition assertion was removed or relaxed.
- An earlier audio run missed an expected word. That result has not reproduced in the latest runs; its original cause remains unconfirmed. A passing example does not establish perfect detection or resolve all recall variability. This limitation is disclosed in the listing copy.
- No separate Edge full-pipeline run has been completed in this preparation session. Test the package in Edge before submission.

## Dashboard blockers

Chrome dashboard: https://chrome.google.com/webstore/devconsole/408020c3-c13a-46d8-9fd2-9432afe39baf

Edge dashboard: https://partner.microsoft.com/en-us/dashboard/home

The shared preview browser required Google sign-in. The logged-in Edge browser was found, but its browser automation refused to script the Chrome extensions gallery. During native Edge inspection, computer use stopped because it could not verify the current browser URL. No dashboard forms were filled, files uploaded, registration terms accepted, or submissions sent. The Edge Partner Center account home showed no workspaces; confirm the correct account and Edge Add-ons developer enrollment/access when browser control resumes.

## Remaining before submission

1. Resume browser access to both dashboards; verify existing listings before creating new ones.
2. Confirm Edge Add-ons developer access; let the account owner review any registration agreement or identity/contact declarations if required.
3. Upload the package, icon, screenshots, and shared copy. Adapt privacy declarations to each dashboard's current definitions, including optional OpenSubtitles transfers.
4. Verify package behavior in Edge and continue investigating if the original missed-word case recurs.
5. Review the completed draft pages with the owner before submitting for review. Do not claim that a store has approved or published the extension until its dashboard confirms that state.
