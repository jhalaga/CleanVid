# CleanVid 2.0 — On-device audio profanity filter (implementation plan)

> **Status (2.0.0): implemented.** What changed from the plan, based on testing against real YouTube:
> - **Direct audio fetch (§2, option 2)** ships as an experimental option. YouTube's web player now uses SABR with
>   no direct `adaptiveFormats[].url`, so it almost always reports `no-direct-url` and the MSE capture is the
>   real source of audio.
> - **Whisper completeness check (new).** Whisper sometimes stops after the first sentence of a window. The engine
>   runs wav2vec2 first, and if Whisper wrote < 60 % of the words wav2vec2 heard, it splits the window at the
>   quietest point and re-transcribes (up to 2 levels).
> - **Alignment peak trimming (new).** If Whisper's text is incomplete, Viterbi parks frames of untranscribed speech
>   on a neighbouring character. Character spans are now limited to frames where p(char) ≥ 0.02, so a word can't
>   stretch over seconds of other speech.
> - **CTC recall boost.** This uses the greedy wav2vec2 transcript (exact matches only, conf ≥ 0.55) instead of a
>   separate keyword-spotting lattice.
> - **Gain scheduling** plans 20 s ahead on the AudioContext clock, so muting stays exact when background-tab
>   timers are throttled to ~1 Hz.
> - **Test set (§7.6).** `npm run e2e:audio` runs the full pipeline on a real video, checks the baseline words and
>   their times, and checks that a reload reuses the cache. A larger hand-labelled set is still to do.

Goal: detect profanity from the **audio itself** (not captions), entirely on-device,
mute it with ~20 ms precision, and never analyse the same stretch of a video twice.

## Pipeline

```
YouTube player ──appendBuffer hook──▶ encoded audio segments (+ media timestamps)
   ▶ demux + decode (WebCodecs) → 16 kHz mono PCM chunks
   ▶ Whisper STT (WebGPU, WASM fallback)          … what was said
   ▶ fuzzy matcher (existing src/shared/matching.js)  … which words are bad
   ▶ wav2vec2 CTC forced alignment (±1 s window)  … exactly when (~20 ms)
   ▶ mute events → IndexedDB cache + live GainNode scheduler
```

UI stages per chunk: **Capturing → Transcribing → Detecting → Aligning → Ready**,
plus a coverage bar on the panel timeline (scanned / in progress / not yet seen).

## 1. First-run onboarding and model download

- `chrome.runtime.onInstalled` (reason `install`) opens `src/onboarding/onboarding.html`.
- The page explains why: speech recognition runs locally, nothing is uploaded, and it
  needs a one-time model download. It shows the sizes and has a **Download** button with a progress bar.
- Two packs (my recommendation; the user can switch later in Options):
  - **Standard** (~150 MB): `whisper-base.en` q8 + `wav2vec2-base-960h` q8.
  - **High accuracy** (~350 MB): `whisper-small.en` / distil + same aligner.
- Models come from a pinned Hugging Face revision (exact commit hash and SHA-256 check)
  and are stored in the Cache API/OPFS, so the extension ships no remote code.
- Until a pack is installed, CleanVid runs in today's caption mode, with a "Get audio
  detection" prompt in the panel and popup.
- Manifest: add `offscreen` and `unlimitedStorage` permissions, host permission for
  `huggingface.co` / `cdn-lfs.hf.co`, and `'wasm-unsafe-eval'` in the extension-pages CSP.

## 2. Audio capture: as much of the video as possible, as early as possible

**Primary: MSE hook (reliable, YouTube-proof).** `bridge.js` (MAIN world) wraps
`MediaSource.addSourceBuffer` / `SourceBuffer.appendBuffer` for `audio/*` buffers. It keeps the
init segment and forwards each media segment, along with its container timestamp (fMP4
`tfdt` / WebM cluster timecode), to the extension. This works the same with DASH or SABR
because all of it ends up in MSE anyway.

Honest limitation: the player only buffers ~30–120 s ahead of the playhead, so the hook alone
cannot scan the whole video on load. Ways to get more, in the order I'd try them:

1. **Use every byte the player fetches.** Seeks, scrubbing and preload all feed the hook.
   Combined with the cache (§4), coverage grows naturally and is never lost.
2. **Direct audio fetch (best-effort whole-video pre-scan).** As soon as the video opens, request
   the audio-only adaptive format (lowest bitrate opus, ~1 MB/min is plenty for ASR) using
   the URLs from the player response the bridge already captures. When that works, the whole
   video is scanned in the background within a minute or two. YouTube actively breaks this
   (n-param, PO tokens, SABR-only responses), so it must be optional, and failure must
   fall back silently to option 1. It needs a spike before we commit to it.
3. *(Rejected)* A hidden second player at high speed. It's fragile, wastes bandwidth and
   looks like bot traffic.

**Scheduling:** a priority queue of 10 s chunks (with 1 s overlap):
1. the chunk under the playhead, then the next ~60 s, which is critical;
2. everything else already buffered or fetched, moving forward from the playhead;
3. earlier parts of the video last.

A seek re-prioritises the queue immediately. Running work is never thrown away; it
simply finishes and gets cached.

**Ads:** ignore segments from ad playback. Track the ad state and the MediaSource instance, so
ad audio is never mapped onto video time.

## 3. Detection precision

- Whisper runs with an initial prompt that includes profanity, which reduces its
  tendency to soften or leave out swear words. Word-level timestamps are used only as a rough location.
- The existing matcher (`matching.js`) flags candidates. Its fuzzy/sensitivity logic is reused unchanged.
- **wav2vec2 forced alignment** on a ±1 s window around each candidate gives exact
  start/end times. It also acts as an independent check: if the CTC score is poor, we use
  Whisper's timing plus extra padding.
- **Recall boost:** run CTC keyword spotting for the word list over chunks where Whisper
  produced `[inaudible]`/low confidence, or where the YouTube ASR caption shows `[ __ ]`.
  This catches words Whisper left out.
- The existing caption matches stay in use as a third signal, merged by time.

## 4. Persistent analysis cache (never redo work)

IndexedDB, keyed by `videoId`:

```js
{
  videoId, duration, pipelineVersion,          // model pack + aligner + algorithm version
  coverage: [[0, 312.4], [600, 845]],          // merged scanned intervals (seconds)
  words:   [{ t0, t1, text, conf }],           // compact transcript, so it can be re-matched
  events:  [{ t0, t1, word, source, conf }]    // ready-to-use mute intervals
}
```

- Storing the **transcript** as well as the events means that changing the word list or
  sensitivity just re-runs the matcher. It takes milliseconds, with no new speech
  recognition. Re-alignment runs only for newly flagged words.
- Coverage intervals are merged, and the scheduler skips anything already covered. A page
  refresh, re-visit or seek costs nothing.
- `pipelineVersion` invalidates old entries when models are upgraded. An LRU limit (e.g. 500 videos)
  stops storage from growing without bound. Raw audio is never stored.

## 5. Muting

- Route the `<video>` through Web Audio: `createMediaElementSource → GainNode → destination`.
- Schedule gain to 0 with a 5–10 ms linear fade and configurable padding (default 40 ms).
  The schedule is mapped from video time to `AudioContext` time, using
  `requestVideoFrameCallback` for drift correction. It is rebuilt on seek, pause and rate change.
- **Safety net:** if playback reaches a stretch that hasn't been scanned, choose between
  (a) caption-based muting only, or (b) auto-pausing briefly until the chunk is ready (an option, default off).
- Optional bleep instead of silence.

## 6. Where code runs (MV3)

| Component | Context |
|---|---|
| appendBuffer hook, player response | `bridge.js` (MAIN world) |
| Panel, Web Audio muting, caption mode | `content.js` |
| Demux/decode, Whisper, wav2vec2, scheduler | **offscreen document** (WebGPU + workers) |
| Cache (IndexedDB), model download, routing | service worker + offscreen |

Audio segments travel content → service worker → offscreen as transferable
`ArrayBuffer`s. One offscreen engine serves all tabs, with the focused tab prioritised.

## 7. Milestones

1. **Spikes (de-risk first):** appendBuffer capture + timestamp mapping; WebGPU Whisper speed
   in an offscreen doc; direct audio fetch feasibility.
2. Onboarding + model download/verification.
3. Chunk pipeline + scheduler + IndexedDB cache + coverage UI.
4. wav2vec2 alignment + CTC keyword spotting.
5. Web Audio mute scheduler; merge with caption signals.
6. Test set: ~20 videos with hand-labelled profanity timestamps (precision, recall, timing
   error). Add it to `npm run e2e` so changes are measured, not guessed.

## Risks

- Model download size and older or low-end GPUs (the WASM fallback is ~5–10× slower).
- Music-heavy or overlapping speech lowers recall.
- YouTube player changes can break the hook. The bridge needs defensive coding and an e2e smoke test.
- The direct fetch may never be reliable. The design works without it.
