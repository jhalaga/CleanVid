# CleanVid privacy policy

Effective date: November 12, 2026

CleanVid is a browser extension maintained by Jozef Halaga. Its purpose is to help reduce profanity in YouTube videos through local audio analysis and caption matching.

## Local processing

CleanVid reads captions and temporarily processes audio from YouTube videos you watch. Speech recognition and word matching run on your computer. CleanVid does not upload your video audio, captions, speech transcripts, word list, or saved analysis to its developer or an analytics service. The extension does not use a microphone or record conversations outside the YouTube player.

## Information stored in your browser

Your settings, custom word list, and optional OpenSubtitles API key are stored in the extension's local browser storage. Downloaded speech models are stored in the browser's cache. Saved analysis contains YouTube video IDs, recognized words, word timings, analysis coverage, and cache metadata. It is stored locally to avoid repeating analysis when possible. Older saved results may be removed as the cache grows.

Raw video audio is processed temporarily in memory and is not saved in the analysis cache. An OpenSubtitles API key is stored locally in browser storage; that storage is not an encrypted secrets vault.

## Network requests and third parties

- **YouTube:** CleanVid requests caption tracks and, when enabled and available, English translations from YouTube. Experimental pre-scanning may request the video's audio directly from YouTube. YouTube receives these requests under its own privacy practices.
- **Hugging Face and its download infrastructure:** If you choose to install speech models, CleanVid downloads model files and configuration data from Hugging Face at pinned revisions. These requests do not contain your video audio, transcripts, custom word list, or YouTube video IDs. The download provider receives ordinary connection metadata, such as your IP address and requested file URLs.
- **OpenSubtitles (optional, off by default):** If you enable this feature, grant site access, and supply your own API key, CleanVid sends the video title and API key to OpenSubtitles to search for and download matching subtitles. Returned subtitles are analyzed locally. OpenSubtitles receives ordinary connection metadata and applies its own privacy practices. Disabling this feature stops future lookups.

CleanVid has no developer-operated backend, advertising, telemetry, or analytics. The developer does not sell user data, use it for advertising, or use it for credit or lending decisions. Information processed by the extension is used only to provide its profanity filtering features. Ordinary service requests to YouTube and optional downloads described above still occur.

## Your choices and deletion

- Turn off CleanVid, audio detection, caption masking, or optional subtitle sources in Settings.
- Use **Saved analysis → Clear** to delete locally saved analysis. Open YouTube tabs can start analyzing again while filtering is enabled.
- Use **Remove models** to remove downloaded speech models.
- Clear the OpenSubtitles API key field and save it to remove the saved key.
- Remove individual words or replace your word list in Settings.
- Uninstalling CleanVid removes its extension-owned browser data according to the browser's normal behavior.

## Policy changes and contact

Changes to these practices will be reflected in this policy with an updated effective date. For privacy questions, open an issue at <https://github.com/jhalaga/CleanVid/issues>. Do not include private video details, API keys, or other sensitive information in a public issue.
