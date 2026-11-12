# Chrome and Edge draft listing

## Shared listing fields

Name: CleanVid — YouTube Profanity Filter

Short description: Mute or bleep profanity on YouTube with local audio detection, caption masking, and a compact timeline.

Suggested category: Accessibility (choose the closest available category in each store).

Language: English

Website / source: https://github.com/jhalaga/CleanVid

Support: https://github.com/jhalaga/CleanVid/issues

Privacy policy: https://github.com/jhalaga/CleanVid/blob/main/docs/PRIVACY.md

Suggested distribution: Free. No purchases, subscriptions, or advertisements.

Graphics: docs/store-assets/01-compact-panel.png and 02-settings.png (1280 × 800); 03-small-promo.png (440 × 280); icon128.png (128 × 128). The first graphic identifies its example caption detections as mocked test data.

### Detailed description

Profanity off. Everything else on.

CleanVid helps reduce profanity while you watch YouTube. It analyzes video audio on your computer and scans captions as a second source, then silences or bleeps detected moments. You can also replace flagged caption text with asterisks.

FEATURES

• On-device English speech recognition with word-level audio alignment.
• Caption matching, including censored spellings and configurable typo tolerance.
• A compact floating panel with a clickable timeline of flagged moments.
• One panel shared by the toolbar icon and floating shield button.
• A flagged-word list that stays collapsed until you open it.
• An editable word list and separate timing padding for audio and caption detections.
• Optional pause-until-analyzed mode and locally saved analysis for repeat viewing.

GETTING STARTED

Install CleanVid, open a YouTube video, and follow the setup page to download a speech model pack if you want audio detection. Speech models are a separate, optional download: the Standard pack is approximately 175–300 MB, depending on the processing backend. Larger packs are available in Settings. Caption filtering can be used without downloading speech models.

PRIVACY

Audio, speech transcripts, settings, word lists, and saved analysis stay on your device. CleanVid has no developer-operated server or analytics. Installing speech models downloads files from Hugging Face. Optional OpenSubtitles lookup is off by default; if enabled with your own API key and site permission, it sends the video title and API key to OpenSubtitles. See the privacy policy for details.

LIMITATIONS

Detection is not guaranteed to catch every word. Loud music, overlapping speech, accents, missing captions, and timing differences can affect results. Speech recognition currently supports English. Other languages can use caption matching with an appropriate custom word list. Analysis generally follows the audio buffered by YouTube, so a new or newly sought section may play before it has been fully analyzed. Pause-until-analyzed can help, but is not a guarantee. Ads are not analyzed. An account is not required for CleanVid itself.

CleanVid is an independent project and is not affiliated with YouTube, Google, Microsoft, Hugging Face, or OpenSubtitles.

## Privacy-practices fields (Chrome)

Single purpose: Help users reduce profanity in YouTube videos by locally analyzing audio and captions, muting or bleeping detected moments, and masking flagged caption text.

Permissions:

- storage: Save user preferences, the custom word list, and the user-supplied optional OpenSubtitles API key locally.
- unlimitedStorage: Keep optional downloaded speech models and local analysis caches, which can exceed ordinary browser storage quotas.
- offscreen: Run local speech-recognition models and their workers in an offscreen extension document while YouTube plays.
- youtube.com / www.youtube.com: Read the YouTube player, caption tracks, buffered video audio, and displayed captions; apply muting and masking; render the floating timeline panel.
- Optional api.opensubtitles.com / *.opensubtitles.com: Only requested when the user enables OpenSubtitles lookup; used to search for and download alternate subtitles using the video title and the user's own API key.

Remote code: All executable JavaScript and WebAssembly used by CleanVid are bundled in the extension. The optional speech-model download contains model weights, tokenizer and configuration data, not downloaded JavaScript or WebAssembly. Revisions are pinned. Reviewers can inspect src/engine/engine.js for local runtime paths and model-loading configuration.

Data declarations must match the store's definitions. The extension processes website content (video audio/captions/title/video ID) locally, and optional OpenSubtitles lookup transmits the title and user-supplied key to that provider. Do not blanket-certify that no data is processed or transmitted. Review the current dashboard's wording and accurately disclose the optional transfer. No advertising, sale of data, or credit/lending use.

## Reviewer testing notes

1. Load the package and open a YouTube watch page. CleanVid does not process other websites.
2. To test audio detection, download the Standard model pack via onboarding or Settings. This may download roughly 175–300 MB and take several minutes. No developer API key or developer-operated server is required.
3. With an English video and matching entries in the word list, wait for analysis coverage to grow. Play or seek into analyzed portions and inspect muted moments. Detection is probabilistic.
4. The toolbar icon and bottom-right shield toggle the same panel. The shield remains visible when the panel is open. Expand Show flagged words to inspect and seek to detections.
5. Test the text matcher in Settings without playing a video. It tests matching rules, not speech-recognition recall.
6. Optional OpenSubtitles integration is off by default and requires the reviewer's own API key and explicit optional site permission. Core filtering does not depend on it.
7. Clear local analysis and remove downloaded speech models from Settings as needed.

## Submission state

The Chrome draft is saved at https://chrome.google.com/webstore/devconsole/408020c3-c13a-46d8-9fd2-9432afe39baf/ehepbfcjgmmpagkaedffoeaigkgldjgl/edit/listing with package, graphics, copy, privacy declarations and reviewer instructions. Category is Tools, language English, distribution free/public/all regions. Submit for review is enabled; nothing has been submitted. See RELEASE-STATUS.md for exact recorded disclosures.

Edge's isolated full-audio test passes. Its draft is not yet created because the account requires Edge Add-ons developer enrollment. Country/account type confirmation from the owner is pending; no registration terms have been accepted.
