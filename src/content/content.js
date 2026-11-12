/**
 * CleanVid — isolated-world content script.
 *
 * Owns the full pipeline: find the current video, ask the MAIN-world bridge
 * for captions, analyze every cue, drive precise muting, mask visible
 * captions, and render the floating panel.
 */
(() => {
  const NS = globalThis.CleanVid;
  if (!NS || !NS.constants || !NS.Matcher || !NS.Captions || NS.contentLoaded) return;
  NS.contentLoaded = true;

  const { constants, Matcher, Captions, Media, Timeline, EngineClient } = NS;
  const {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    formatTime,
    clampProgress,
    debounce,
    pluralize,
    saveSettings,
    getVideoIdFromUrl,
  } = constants;

  const CONTENT_SOURCE = 'cleanvid-content';
  const BRIDGE_SOURCE = 'cleanvid-bridge';
  const CHUNK_SIZE = 40;
  const MAX_LIST_ROWS = 250;

  let settings = { ...DEFAULT_SETTINGS };
  let words = [];
  let matcher = Matcher.buildIndex(words, settings.sensitivity);

  const state = {
    pageUrl: location.href,
    videoId: null,
    title: '',
    duration: 0,
    tracks: [],
    track: null,
    status: 'idle',
    stage: '',
    progress: 0,
    source: '',
    occurrences: [],
    intervals: [],
    cues: [],
    cueCount: 0,
    analyzedCues: 0,
    error: '',
    startedAt: 0,
    analyzedAt: 0,
    captionOccurrences: [],
  };

  // On-device audio analysis (offscreen engine).
  const audio = {
    model: { status: 'unknown', pack: null, device: null, progress: null, error: '' },
    coverage: [],
    available: [],
    words: [],
    ctc: [],
    stage: 'idle',
    stageRange: null,
    error: '',
    lastChunkAt: 0,
    rtf: 0,
    gainReady: false,
    prefetch: '',
    sentHelloFor: null,
    lastPlayheadAt: 0,
    autoPause: null,
    autoPauseCooldownUntil: 0,
    occurrenceKey: '',
  };
  let engine = null;

  let host = null;
  let shadow = null;
  let refs = {};
  let collapsed = false;
  let listExpanded = false;
  let runningToken = 0;
  let listVersion = 0;
  let renderedListVersion = -1;
  let renderedTimelineKey = '';
  let currentRow = -1;
  let fallbackTimer = null;
  let maskObserver = null;
  let maskTimer = null;
  let watchedVideo = null;
  let pendingRequests = new Map();
  let requestSeq = 0;

  const mutedElements = new Set();
  const maskRecords = new WeakMap();
  const mute = {
    userMuted: false,
    applied: false,
    applying: false,
    expected: false,
    expectedUntil: 0,
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });

  function maskLabel(value) {
    const chars = [...String(value || '')];
    return chars
      .map((ch, index) => (index > 0 && /[\p{L}\p{N}]/u.test(ch) ? '*' : ch))
      .join('');
  }

  function ruleLabel(rule) {
    switch (rule) {
      case 'masked':
        return 'censored';
      case 'fuzzy':
        return 'fuzzy';
      case 'joined':
        return 'compound';
      case 'spelled':
        return 'spelled';
      default:
        return 'exact';
    }
  }

  function occurrenceLabel(occurrence) {
    if (occurrence.source === 'audio') return 'heard';
    if (occurrence.source === 'ctc') return 'heard·raw';
    return occurrence.entry === '[ __ ]' ? 'cc [__]' : `cc ${ruleLabel(occurrence.rule)}`;
  }

  function occurrenceTitle(occurrence) {
    const span = `${occurrence.start.toFixed(2)}s–${occurrence.end.toFixed(2)}s`;
    if (occurrence.source === 'audio') return `Heard in the audio (Whisper + wav2vec2 alignment), ${span}`;
    if (occurrence.source === 'ctc') return `Heard by the acoustic model alone, ${span}`;
    return `From captions (${ruleLabel(occurrence.rule)} match), ${span}`;
  }

  function sourceName(source, track) {
    if (source === 'transcript') return 'Transcript panel';
    if (source === 'direct') return 'Direct captions';
    if (source === 'captured' || source === 'player') return 'Player captions';
    return track ? Captions.trackLabel(track) : 'Captions';
  }

  // --- Bridge messaging -----------------------------------------------------

  function postToBridge(message) {
    try {
      window.postMessage({ source: CONTENT_SOURCE, ...message }, location.origin);
    } catch {
      try {
        window.postMessage({ source: CONTENT_SOURCE, ...message }, '*');
      } catch {
        /* ignore */
      }
    }
  }

  function requestBridge(action, payload = {}, timeoutMs = 15000) {
    const id = `cv-${Date.now()}-${++requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        resolve({ ok: false, error: 'The page bridge did not respond.' });
      }, timeoutMs);
      pendingRequests.set(id, { resolve, timer });
      postToBridge({ type: 'request', id, action, payload });
    });
  }

  function onBridgeMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE) return;

    if (data.type === 'response') {
      const pending = pendingRequests.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(data.id);
      pending.resolve(data);
      return;
    }

    if (data.type === 'player') handlePlayerPayload(data.payload);
    else if (data.type === 'audio') forwardAudio(data);
    else if (data.type === 'gain') {
      const ready = Boolean(data.ready);
      if (ready !== audio.gainReady) {
        audio.gainReady = ready;
        // Hand muting over to (or back from) the Web Audio scheduler.
        if (ready && mute.applied && !mute.userMuted) setVideoMuted(mute.userMuted);
        checkMute(true);
      }
    } else if (data.type === 'prefetch-result') {
      if (data.videoId === state.videoId) audio.prefetch = data.reason || '';
    }
  }

  // --- Audio engine ---------------------------------------------------------

  function audioWanted() {
    return Boolean(settings.enabled && settings.audioEnabled && state.videoId);
  }

  function audioActive() {
    return audioWanted() && ['ready', 'loading', 'installed'].includes(audio.model.status);
  }

  function unpackWords(list) {
    return (Array.isArray(list) ? list : []).map((w) => ({ t0: w[0], t1: w[1], text: w[2], conf: w[3] }));
  }

  function ensureEngine() {
    if (!audioWanted()) return;
    if (!engine) {
      engine = EngineClient.create({
        onMessage: onEngineMessage,
        onConnect: () => {
          audio.sentHelloFor = null;
          sendHello();
        },
      });
    }
    engine.connect();
    sendHello();
  }

  function sendHello() {
    if (!engine || !engine.connected) return;
    const videoId = audioWanted() ? state.videoId : null;
    if (audio.sentHelloFor === videoId) return;
    audio.sentHelloFor = videoId;
    engine.post({ type: 'hello', videoId, duration: state.duration, pack: settings.modelPack });
    postToBridge({ type: 'audio-listen', enabled: Boolean(videoId) });
    sendPlayhead(true);
  }

  function stopAudio() {
    postToBridge({ type: 'audio-listen', enabled: false });
    postToBridge({ type: 'prefetch-stop' });
    if (engine) {
      engine.close();
      engine = null;
    }
    audio.sentHelloFor = null;
  }

  function resetAudio() {
    audio.coverage = [];
    audio.available = [];
    audio.words = [];
    audio.ctc = [];
    audio.stage = 'idle';
    audio.stageRange = null;
    audio.error = '';
    audio.lastChunkAt = 0;
    audio.prefetch = '';
    audio.autoPause = null;
    audio.occurrenceKey = '';
  }

  function forwardAudio(message) {
    if (!audioWanted() || !engine) return;
    if (['missing', 'error'].includes(audio.model.status)) return;
    if (message.videoId && message.videoId !== state.videoId) return;
    if (message.kind === 'reset') {
      engine.post({ type: 'reset', key: message.key }, { queueIfOffline: false });
      return;
    }
    if (message.kind !== 'append' || !message.bytes) return;
    if (message.ad || isAdShowing()) return;
    const msDuration = Number(message.msDuration);
    if (
      Number.isFinite(msDuration) &&
      msDuration > 0 &&
      state.duration > 30 &&
      Math.abs(msDuration - state.duration) > 3
    ) {
      return; // a different (ad) MediaSource
    }
    engine.post({
      type: 'append',
      videoId: state.videoId,
      key: message.key,
      mime: message.mime,
      offset: message.offset || 0,
      b64: Media.base64FromBytes(new Uint8Array(message.bytes)),
    });
  }

  function sendPlayhead(force = false) {
    if (!engine || !engine.connected || !watchedVideo || !audioWanted()) return;
    const now = Date.now();
    if (!force && now - audio.lastPlayheadAt < 1000) return;
    audio.lastPlayheadAt = now;
    engine.post(
      {
        type: 'playhead',
        time: watchedVideo.currentTime || 0,
        rate: watchedVideo.playbackRate || 1,
        paused: Boolean(watchedVideo.paused),
      },
      { queueIfOffline: false }
    );
  }

  function onEngineMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'model') {
      const before = audio.model.status;
      audio.model = {
        status: message.status,
        pack: message.pack,
        device: message.device,
        progress: message.progress,
        error: message.error || '',
      };
      if (message.status === 'ready' && before !== 'ready') maybePrefetch();
      render();
      return;
    }
    if (message.videoId && message.videoId !== state.videoId) return;
    if (message.type === 'video') {
      audio.coverage = message.coverage || [];
      audio.available = message.available || [];
      audio.words = unpackWords(message.words);
      audio.ctc = unpackWords(message.ctc);
      recombine();
      maybePrefetch();
    } else if (message.type === 'available') {
      audio.available = message.available || [];
      renderAudio();
    } else if (message.type === 'chunk') {
      const [start, end] = message.range;
      audio.words = Timeline.spliceWords(audio.words, unpackWords(message.words), start, end);
      audio.ctc = Timeline.spliceWords(audio.ctc, unpackWords(message.ctc), start, end);
      audio.coverage = message.coverage || Timeline.add(audio.coverage, [start, end]);
      audio.lastChunkAt = Date.now();
      audio.rtf = message.rtf || 0;
      audio.error = '';
      recombine();
    } else if (message.type === 'stage') {
      audio.stage = message.stage;
      audio.stageRange = message.range || null;
      if (message.stage === 'error') audio.error = message.error || 'Analysis failed';
      renderAudio();
    }
  }

  function maybePrefetch() {
    if (!settings.audioPrefetch || audio.model.status !== 'ready' || !state.videoId) return;
    if (state.duration > 0 && Timeline.total(audio.coverage) >= state.duration - 2) return;
    postToBridge({ type: 'prefetch-start', videoId: state.videoId });
  }

  /** Merge audio, acoustic and caption detections into mute intervals. */
  function recombine() {
    const audioHits = Timeline.matchWords(matcher, audio.words, { source: 'audio' });
    const ctcHits = Timeline.matchWords(matcher, audio.ctc, { source: 'ctc' });
    const combined = Timeline.combine({
      audio: audioHits,
      ctc: ctcHits,
      captions: state.captionOccurrences,
      coverage: audio.coverage,
    });
    const key = combined.map((o) => `${o.start.toFixed(2)}:${o.end.toFixed(2)}:${o.source}`).join('|');
    if (key !== audio.occurrenceKey) {
      audio.occurrenceKey = key;
      state.occurrences = combined;
      state.intervals = buildIntervals(state.occurrences, settings.mutePaddingMs, settings.audioPaddingMs);
      listVersion += 1;
      updateBadge();
      sendGainIntervals();
      checkMute(true);
    }
    render();
  }

  function sendGainIntervals() {
    postToBridge({
      type: 'gain-intervals',
      intervals: state.intervals,
      active: Boolean(settings.enabled && settings.muteAudio && state.videoId),
      style: settings.muteStyle,
    });
  }

  /** Optional: pause briefly when playback reaches audio not analysed yet. */
  function checkAutoPause() {
    if (!watchedVideo) return;
    const pending = audio.autoPause;
    const t = watchedVideo.currentTime;
    if (pending) {
      const covered = Timeline.aheadOf(audio.coverage, t) >= 4 ||
        (state.duration > 0 && Timeline.aheadOf(audio.coverage, t) >= state.duration - t - 0.5);
      const timedOut = Date.now() - pending.at > 15000;
      if (covered || timedOut || !settings.pauseOnUnscanned) {
        audio.autoPause = null;
        if (timedOut) audio.autoPauseCooldownUntil = Date.now() + 30000;
        if (watchedVideo.paused && pending.paused) {
          const promise = watchedVideo.play();
          if (promise && promise.catch) promise.catch(() => {});
        }
        render();
      }
      return;
    }
    if (!settings.pauseOnUnscanned || audio.model.status !== 'ready' || !audioWanted()) return;
    if (watchedVideo.paused || isAdShowing() || Date.now() < audio.autoPauseCooldownUntil) return;
    if (Timeline.contains(audio.coverage, t + 0.4)) return;
    if (!Timeline.contains(audio.available, t + 0.6, 0.2)) return; // nothing to analyse yet
    try {
      watchedVideo.pause();
      audio.autoPause = { at: Date.now(), paused: true };
      render();
    } catch {
      /* ignore */
    }
  }

  function handlePlayerPayload(payload) {
    if (!payload) return;
    const urlId = getVideoIdFromUrl(location.href);
    if (!urlId) return;
    if (payload.videoId && payload.videoId !== urlId) return;
    if (!state.videoId) state.videoId = urlId;

    if (payload.title) state.title = payload.title;
    if (Number(payload.duration) > 0 && Number(payload.duration) !== state.duration) {
      state.duration = Number(payload.duration);
      if (engine) engine.post({ type: 'duration', duration: state.duration }, { queueIfOffline: false });
    }
    if (Array.isArray(payload.tracks)) state.tracks = payload.tracks;
    bindVideo(findVideo());
    ensureEngine();

    if (state.status === 'waiting' && state.tracks.length) startAnalysis();
    else render();
  }

  function requestPlayerData() {
    requestBridge('get-player', {}, 5000)
      .then((response) => {
        if (response && response.ok && response.data) handlePlayerPayload(response.data);
      })
      .catch(() => {});
  }

  // --- Video lifecycle ------------------------------------------------------

  function findVideo() {
    return (
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  }

  function bindVideo(next) {
    if (!next || next === watchedVideo) return;
    if (watchedVideo) {
      watchedVideo.removeEventListener('timeupdate', onTimeUpdate);
      watchedVideo.removeEventListener('seeked', onTimeUpdate);
      watchedVideo.removeEventListener('playing', onTimeUpdate);
      watchedVideo.removeEventListener('durationchange', onDurationChange);
      watchedVideo.removeEventListener('volumechange', onVolumeChange);
      try {
        if (mute.applied && !mute.userMuted) watchedVideo.muted = false;
      } catch {
        /* ignore */
      }
    }
    watchedVideo = next;
    mute.userMuted = Boolean(next.muted);
    mute.applied = Boolean(next.muted);
    mute.expected = Boolean(next.muted);
    mute.expectedUntil = 0;
    next.addEventListener('timeupdate', onTimeUpdate);
    next.addEventListener('seeked', onTimeUpdate);
    next.addEventListener('playing', onTimeUpdate);
    next.addEventListener('durationchange', onDurationChange);
    next.addEventListener('volumechange', onVolumeChange);
    if (!state.duration && Number.isFinite(next.duration)) {
      state.duration = next.duration;
    }
  }

  function onTimeUpdate(event) {
    checkMute();
    if (event && (event.type === 'seeked' || event.type === 'playing')) sendPlayhead(true);
  }

  function onDurationChange() {
    if (watchedVideo && Number.isFinite(watchedVideo.duration) && watchedVideo.duration > 0) {
      state.duration = watchedVideo.duration;
      render();
    }
  }

  function onVolumeChange() {
    if (!watchedVideo) return;
    if (mute.applying) return;
    if (
      watchedVideo.muted === mute.expected &&
      Date.now() < mute.expectedUntil
    ) {
      return;
    }
    mute.userMuted = Boolean(watchedVideo.muted);
    mute.applied = mute.userMuted;
  }

  function onNavigate() {
    const urlId = getVideoIdFromUrl(location.href);
    state.pageUrl = location.href;
    if (!urlId) {
      if (state.videoId || state.status !== 'idle') teardownVideo();
      if (host) host.hidden = true;
      return;
    }

    ensurePanel();
    if (!host) return;
    host.hidden = false;

    if (urlId !== state.videoId) {
      resetVideo(urlId);
      bindVideo(findVideo());
      requestPlayerData();
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        if (state.videoId === urlId && state.status === 'waiting') {
          if (settings.useTranscriptFallback) {
            startTranscript(++runningToken, 'The player did not expose captions.');
          } else {
            fail(
              runningToken,
              'empty',
              'No caption tracks were found. Turn on captions and re-scan.'
            );
          }
        }
      }, 9000);
    } else {
      bindVideo(findVideo());
      if (state.status === 'idle') {
        resetVideo(urlId);
        requestPlayerData();
      }
    }
    render();
  }

  function resetVideo(videoId) {
    runningToken += 1;
    clearTimeout(fallbackTimer);
    restoreMute();
    state.videoId = videoId;
    state.title = String(document.title || '').replace(/\s*-\s*YouTube\s*$/i, '');
    state.duration = 0;
    state.tracks = [];
    state.track = null;
    state.status = 'waiting';
    state.stage = 'Waiting for the player…';
    state.progress = 2;
    state.source = '';
    state.occurrences = [];
    state.intervals = [];
    state.captionOccurrences = [];
    state.cues = [];
    state.cueCount = 0;
    state.analyzedCues = 0;
    state.error = '';
    state.startedAt = Date.now();
    state.analyzedAt = 0;
    listVersion += 1;
    currentRow = -1;
    resetAudio();
    postToBridge({ type: 'prefetch-stop' });
    sendGainIntervals();
    updateBadge();
    ensureEngine();
  }

  function teardownVideo() {
    runningToken += 1;
    clearTimeout(fallbackTimer);
    restoreMute();
    stopMasking();
    state.videoId = null;
    state.title = '';
    state.tracks = [];
    state.track = null;
    state.status = 'idle';
    state.stage = '';
    state.progress = 0;
    state.source = '';
    state.occurrences = [];
    state.intervals = [];
    state.captionOccurrences = [];
    state.cues = [];
    state.cueCount = 0;
    state.analyzedCues = 0;
    state.error = '';
    listVersion += 1;
    resetAudio();
    postToBridge({ type: 'prefetch-stop' });
    sendGainIntervals();
    if (engine) sendHello();
    updateBadge();
  }

  // --- Analysis pipeline ----------------------------------------------------

  async function startAnalysis() {
    if (!state.videoId || !matcher) return;
    if (state.status === 'loading' || state.status === 'analyzing') return;
    const my = ++runningToken;
    clearTimeout(fallbackTimer);

    state.status = 'loading';
    state.stage = 'Choosing a caption track…';
    state.progress = 5;
    state.source = '';
    state.error = '';
    state.cues = [];
    state.cueCount = 0;
    // Audio detections stay active while captions reload.
    state.captionOccurrences = [];
    recombine();
    updateBadge();

    const externalPromise = settings.useOpenSubtitles
      ? requestOpenSubtitlesCues(my)
      : Promise.resolve({ cues: [], title: '', error: '' });

    const tracks = Captions.scanTracks(state.tracks, settings.captionLanguage);
    if (!tracks.length) {
      await startTranscript(my, 'No caption tracks were found.', externalPromise);
      return;
    }

    state.track = tracks[0];
    state.stage = tracks.length > 1
      ? `Loading ${tracks.length} caption tracks…`
      : `Loading ${Captions.trackLabel(tracks[0])} captions…`;
    state.progress = 12;
    render();

    const cues = [];
    const sources = [];
    let firstError = '';
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      state.stage = `Loading captions ${index + 1}/${tracks.length}: ${Captions.trackLabel(track)}…`;
      state.progress = 12 + Math.round((index / tracks.length) * 12);
      render();
      const response = await requestBridge(
        'captions',
        {
          track,
          videoId: state.videoId,
          translationLanguage:
            settings.tryYouTubeTranslation && track.isTranslatable ? 'en' : '',
        },
        40000
      );
      if (my !== runningToken) return;
      if (!response || !response.ok || !response.data) {
        if (!firstError && response && response.error) firstError = response.error;
        continue;
      }

      const sourceCues = Captions.parseResponse(response.data.text || '');
      if (sourceCues.length) {
        cues.push(...sourceCues);
        sources.push(sourceName(response.data.source, track));
      }
      const translatedCues = settings.tryYouTubeTranslation
        ? Captions.parseResponse(response.data.translatedText || '')
        : [];
      if (translatedCues.length) {
        cues.push(...translatedCues);
        sources.push(`${Captions.trackLabel(track)} → YouTube English translation`);
      }
    }

    if (my !== runningToken) return;
    if (cues.length) {
      state.stage = 'Combining caption sources…';
      state.progress = 26;
      state.source = [...new Set(sources)].join(' + ');
      render();
      const external = await externalPromise;
      if (my !== runningToken) return;
      const supplemental = compatibleExternalCues(external, state.duration);
      if (supplemental.length) {
        cues.push(...supplemental);
        state.source += ` + OpenSubtitles (${external.title || 'English'})`;
      }
      await analyzeCues(cues, my);
      return;
    }

    await startTranscript(
      my,
      firstError || 'The caption response was empty.',
      externalPromise
    );
  }

  async function requestOpenSubtitlesCues(my) {
    const apiKey = await constants.getOpenSubtitlesKey();
    if (!apiKey) return { cues: [], title: '', error: 'OpenSubtitles API key is missing.' };
    if (my !== runningToken) return { cues: [], title: '', error: 'Scan was superseded.' };
    state.stage = 'Looking for an English OpenSubtitles transcript…';
    state.progress = Math.max(state.progress, 16);
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'lookup-opensubtitles',
        title: state.title,
        apiKey,
      });
      if (!response || !response.ok) {
        return { cues: [], title: '', error: response && response.error ? response.error : 'No OpenSubtitles result.' };
      }
      return {
        cues: Captions.parseResponse(response.text || ''),
        title: response.title || '',
        error: '',
      };
    } catch (error) {
      return {
        cues: [],
        title: '',
        error: error && error.message ? error.message : 'OpenSubtitles lookup failed.',
      };
    }
  }

  function compatibleExternalCues(result, duration) {
    const cues = result && Array.isArray(result.cues) ? result.cues : [];
    if (!cues.length) return [];
    const lastEnd = cues.reduce((latest, cue) => Math.max(latest, Number(cue.end) || 0), 0);
    if (duration > 30) {
      const tolerance = Math.max(45, duration * 0.03);
      if (lastEnd > duration + 15 || Math.abs(lastEnd - duration) > tolerance) return [];
    }
    return cues.map((cue) => ({ ...cue, external: true }));
  }

  async function startTranscript(my, reason, externalPromise = Promise.resolve({ cues: [] })) {
    if (my !== runningToken) return;
    const external = await externalPromise;
    if (my !== runningToken) return;
    const externalCues = compatibleExternalCues(external, state.duration);
    if (!settings.useTranscriptFallback) {
      if (externalCues.length) {
        state.source = `OpenSubtitles (${external.title || 'English'})`;
        await analyzeCues(externalCues, my);
        return;
      }
      fail(
        my,
        'empty',
        `${reason} Transcript fallback is disabled in settings.${external && external.error ? ` ${external.error}` : ''}`
      );
      return;
    }

    state.status = 'loading';
    state.stage = 'Opening the transcript panel…';
    state.progress = 20;
    render();

    try {
      const cues = await scrapeTranscript();
      if (my !== runningToken) return;
      if (!cues.length) throw new Error('The transcript was empty.');
      state.source = 'Transcript panel';
      if (externalCues.length) {
        state.source += ` + OpenSubtitles (${external.title || 'English'})`;
      }
      await analyzeCues(cues.concat(externalCues), my);
    } catch (error) {
      if (my !== runningToken) return;
      if (externalCues.length) {
        state.source = `OpenSubtitles (${external.title || 'English'})`;
        await analyzeCues(externalCues, my);
        return;
      }
      fail(
        my,
        'empty',
        error && error.message
          ? error.message
          : 'No captions were available for this video.'
      );
    }
  }

  function fail(my, status, message) {
    if (my !== runningToken) return;
    state.status = status;
    state.stage = status === 'empty' ? 'No captions found' : 'Analysis failed';
    state.error = message;
    state.progress = 0;
    state.source = '';
    state.cues = [];
    state.cueCount = 0;
    state.captionOccurrences = [];
    recombine();
    updateBadge();
  }

  async function analyzeCues(cues, my) {
    if (my !== runningToken) return;
    const sorted = cues
      .filter((cue) => cue && cue.text && Number.isFinite(cue.start))
      .sort((a, b) => a.start - b.start);

    state.cues = sorted;
    state.cueCount = sorted.length;
    state.analyzedCues = 0;
    state.status = 'analyzing';
    state.stage = `Scanning ${sorted.length} caption lines…`;
    state.progress = 30;
    state.error = '';
    render();

    const found = [];
    let lastPaint = 0;

    for (let i = 0; i < sorted.length; i++) {
      if (my !== runningToken) return;
      const cue = sorted[i];
      const { matches } = matcher.analyze(cue.text);
      for (const match of matches) {
        const span = Captions.spanForMatch(cue, match.start, match.end);
        found.push({
          start: span.start,
          end: span.end,
          entry: match.entry.raw,
          rule: match.rule,
          text: match.matchedText,
          cue: i,
        });
      }
      // YouTube's auto-captions replace profanity with "[ __ ]" but keep its
      // word timing: a free, reliable hint.
      CENSOR_RE.lastIndex = 0;
      let censored;
      while ((censored = CENSOR_RE.exec(cue.text))) {
        const span = Captions.spanForMatch(cue, censored.index, censored.index + censored[0].length);
        found.push({
          start: span.start,
          end: Math.min(span.end, span.start + 1.2),
          entry: '[ __ ]',
          rule: 'masked',
          text: 'f***',
          cue: i,
        });
      }
      state.analyzedCues = i + 1;

      const now = performance.now();
      if (now - lastPaint > 90 || i === sorted.length - 1) {
        state.progress = 30 + ((i + 1) / sorted.length) * 66;
        state.stage = `Scanning captions… ${i + 1} / ${sorted.length}`;
        render();
        lastPaint = now;
      }
      if ((i + 1) % CHUNK_SIZE === 0) await delay(0);
    }
    if (my !== runningToken) return;

    const occurrences = dedupeOccurrences(found);
    state.captionOccurrences = occurrences.map((o) => ({ ...o, source: 'captions' }));
    state.status = 'ready';
    state.progress = 100;
    state.stage = occurrences.length
      ? `Captions — ${occurrences.length} flagged ${pluralize(occurrences.length, 'moment')}`
      : 'Captions — no flagged words found';
    state.analyzedAt = Date.now();
    audio.occurrenceKey = '';
    recombine();
    updateBadge();
    applyMaskToVisible();
    checkMute(true);
  }

  const CENSOR_RE = /\[\s*_{2,}\s*\]/g;

  function dedupeOccurrences(list) {
    const sorted = [...list].sort(
      (a, b) => a.start - b.start || a.end - b.end
    );
    const out = [];
    for (const occurrence of sorted) {
      const previous = out[out.length - 1];
      if (previous) {
        const sameEntry = previous.entry === occurrence.entry;
        const threshold = sameEntry ? 0.45 : 0.18;
        if (Math.abs(occurrence.start - previous.start) < threshold) {
          previous.end = Math.max(previous.end, occurrence.end);
          continue;
        }
        if (
          sameEntry &&
          occurrence.start < previous.end &&
          occurrence.end <= previous.end + 0.2
        ) {
          continue;
        }
      }
      out.push({ ...occurrence });
    }
    return out;
  }

  function buildIntervals(occurrences, paddingMs, audioPaddingMs = paddingMs) {
    const captionPadding = Math.max(0, Number(paddingMs) || 0) / 1000;
    const audioPadding = Math.max(0, Number(audioPaddingMs) || 0) / 1000;
    const sorted = [...occurrences].sort((a, b) => a.start - b.start);
    const intervals = [];
    for (const occurrence of sorted) {
      // Audio-aligned words are precise; caption timing needs more slack.
      const padding = occurrence.source === 'audio' || occurrence.source === 'ctc' ? audioPadding : captionPadding;
      const start = Math.max(0, occurrence.start - padding);
      const end = occurrence.end + padding;
      const last = intervals[intervals.length - 1];
      if (last && start <= last.end + 0.05) {
        last.end = Math.max(last.end, end);
      } else {
        intervals.push({ start, end });
      }
    }
    return intervals;
  }

  async function rescan() {
    if (!state.videoId) return;
    if (!state.tracks.length) {
      startTranscript(++runningToken, 'No caption tracks were found.');
      return;
    }
    await startAnalysis();
  }

  // --- Transcript fallback --------------------------------------------------

  function cleanTranscriptText(value) {
    return Captions.cleanText(value);
  }

  function transcriptText(node) {
    const raw = node.textContent || '';
    const record = maskRecords.get(node);
    return record && raw === record.output ? record.input : raw;
  }

  function collectTranscriptSegments() {
    const nodes = document.querySelectorAll('ytd-transcript-segment-renderer');
    const out = [];
    for (const node of nodes) {
      const timeNode = node.querySelector('.segment-timestamp');
      const textNode =
        node.querySelector('.segment-text') ||
        node.querySelector('#content-text') ||
        node.querySelector('yt-formatted-string');
      if (!timeNode || !textNode) continue;
      const start = Captions.parseTimestamp(timeNode.textContent);
      const text = cleanTranscriptText(transcriptText(textNode));
      if (!Number.isFinite(start) || start < 0 || !text) continue;
      out.push({ start, end: start + 2, text, segments: null });
    }
    return out;
  }

  async function findTranscriptButton() {
    const find = () => {
      const selectors = [
        'ytd-video-description-transcript-section-renderer button',
        'button[aria-label*="transcript" i]',
        'yt-button-shape button[aria-label*="transcript" i]',
        '#show-transcript',
      ];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
      }
      return null;
    };

    let button = find();
    if (button) return button;

    const expand = document.querySelector(
      'tp-yt-paper-button#expand, ytd-text-inline-expander #expand, #expand'
    );
    if (expand) {
      expand.click();
      await delay(400);
      button = find();
      if (button) return button;
    }
    return null;
  }

  function findTranscriptScroller() {
    const container =
      document.querySelector('ytd-transcript-segment-list-renderer #segments-container') ||
      document.querySelector('#segments-container');
    if (container) return container;
    let element = document.querySelector('ytd-transcript-segment-renderer');
    if (!element) return null;
    element = element.parentElement;
    while (element && element !== document.body) {
      if (element.scrollHeight > element.clientHeight + 24) return element;
      element = element.parentElement;
    }
    return null;
  }

  async function scrapeTranscript() {
    let openedByUs = false;
    let toggleButton = null;
    let segments = collectTranscriptSegments();

    if (!segments.length) {
      toggleButton = await findTranscriptButton();
      if (!toggleButton) {
        throw new Error(
          'No captions were found. Turn on CC or open “Show transcript”, then re-scan.'
        );
      }
      toggleButton.click();
      openedByUs = true;
      const started = Date.now();
      while (Date.now() - started < 7000) {
        await delay(180);
        segments = collectTranscriptSegments();
        if (segments.length) break;
      }
    }

    const unique = new Map();
    const collect = () => {
      for (const segment of collectTranscriptSegments()) {
        const key = `${segment.start.toFixed(2)}|${segment.text}`;
        if (!unique.has(key)) unique.set(key, segment);
      }
    };
    collect();

    const scroller = findTranscriptScroller();
    if (scroller) {
      for (let pass = 0; pass < 60; pass++) {
        const before = unique.size;
        try {
          scroller.scrollTop = scroller.scrollHeight;
        } catch {
          break;
        }
        await delay(220);
        collect();
        if (unique.size === before) break;
      }
    }

    if (openedByUs) {
      const close =
        document.querySelector('ytd-transcript-renderer #close-button button') ||
        document.querySelector('button[aria-label*="Close transcript" i]');
      if (close) {
        close.click();
      } else if (toggleButton) {
        toggleButton.click();
      }
    }

    const items = [...unique.values()].sort((a, b) => a.start - b.start);
    if (!items.length) throw new Error('The transcript panel was empty.');
    for (let i = 0; i < items.length; i++) {
      const next = items[i + 1];
      const wordCount = items[i].text.split(/\s+/).length;
      const estimate = Math.max(1.2, Math.min(12, wordCount / 2.4));
      let end = items[i].start + estimate;
      if (next) end = Math.min(end, Math.max(items[i].start + 0.8, next.start));
      items[i].end = Math.max(items[i].start + 0.8, end);
      items[i].segments = null;
    }
    return items;
  }

  // --- Muting ---------------------------------------------------------------

  function isAdShowing() {
    const player = document.getElementById('movie_player');
    return Boolean(player && player.classList.contains('ad-showing'));
  }

  function intervalAt(time) {
    const list = state.intervals;
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const interval = list[middle];
      if (time < interval.start) high = middle - 1;
      else if (time > interval.end) low = middle + 1;
      else return interval;
    }
    return null;
  }

  function setVideoMuted(value) {
    if (!watchedVideo) return;
    const desired = Boolean(value);
    if (watchedVideo.muted === desired) {
      mute.applied = desired;
      mute.expected = desired;
      return;
    }
    mute.applying = true;
    mute.expected = desired;
    mute.expectedUntil = Date.now() + 700;
    try {
      watchedVideo.muted = desired;
    } catch {
      /* ignore */
    }
    mute.applied = desired;
    setTimeout(() => {
      mute.applying = false;
    }, 120);
  }

  function restoreMute() {
    if (watchedVideo) setVideoMuted(mute.userMuted);
    mute.applied = mute.userMuted;
    if (host) host.dataset.muting = 'false';
  }

  function checkMute(force = false) {
    if (!watchedVideo) return;
    const time = watchedVideo.currentTime;
    const active =
      settings.enabled &&
      settings.muteAudio &&
      state.intervals.length > 0 &&
      !isAdShowing() &&
      Boolean(intervalAt(time));

    // With the Web Audio scheduler in place the page bridge mutes with
    // sample accuracy; video.muted is only the fallback.
    let desired = mute.userMuted;
    if (active && !audio.gainReady) desired = true;
    setVideoMuted(desired);
    if (host) host.dataset.muting = active ? 'true' : 'false';
    if (force || Date.now() - lastHighlightAt > 120) {
      lastHighlightAt = Date.now();
      highlightCurrent(time);
    }
  }
  let lastHighlightAt = 0;

  function highlightCurrent(time) {
    if (!refs.list) return;
    if (!settings.highlightCurrent) {
      if (currentRow !== -1) {
        const rows = refs.list.querySelectorAll('.cv-row');
        for (let i = 0; i < rows.length; i++) {
          rows[i].classList.remove('is-current');
        }
        currentRow = -1;
      }
      return;
    }
    if (!state.occurrences.length) return;
    let active = -1;
    for (let i = 0; i < state.occurrences.length; i++) {
      const occurrence = state.occurrences[i];
      if (time >= occurrence.start - 0.08 && time <= occurrence.end + 0.08) {
        active = i;
        break;
      }
    }
    if (active === currentRow) return;
    currentRow = active;
    const rows = refs.list.querySelectorAll('.cv-row');
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-current', i === active);
    }
  }

  // --- Caption masking ------------------------------------------------------

  function setMasking(enabled) {
    if (enabled) {
      if (!maskObserver) {
        maskObserver = new MutationObserver(() => scheduleMask(80));
        maskObserver.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      }
      scheduleMask(0);
    } else {
      if (maskObserver) {
        maskObserver.disconnect();
        maskObserver = null;
      }
      restoreMasked();
    }
  }

  function scheduleMask(wait) {
    clearTimeout(maskTimer);
    maskTimer = setTimeout(applyMaskToVisible, wait == null ? 80 : wait);
  }

  function applyMaskToVisible() {
    if (!settings.enabled || !settings.maskCaptions || !matcher) return;
    for (const element of mutedElements) {
      if (!element.isConnected) mutedElements.delete(element);
    }
    const nodes = new Set();
    for (const selector of [
      '.ytp-caption-segment',
      'ytd-transcript-segment-renderer .segment-text',
      'ytd-transcript-segment-renderer #content-text',
    ]) {
      for (const node of document.querySelectorAll(selector)) nodes.add(node);
    }
    for (const node of nodes) maskElement(node);
  }

  function maskElement(element) {
    if (!element || !element.isConnected) return;
    const current = element.textContent || '';
    if (!current.trim()) return;

    const record = maskRecords.get(element);
    if (record && current === record.output) {
      mutedElements.add(element);
      return;
    }

    const { matches } = matcher.analyze(current);
    if (!matches.length) return;

    let output = '';
    let cursor = 0;
    for (const match of matches) {
      output += current.slice(cursor, match.start);
      output += current
        .slice(match.start, match.end)
        .replace(/[\p{L}\p{N}]/gu, '*');
      cursor = match.end;
    }
    output += current.slice(cursor);
    if (output === current) return;

    maskRecords.set(element, { input: current, output });
    mutedElements.add(element);
    element.textContent = output;
  }

  function restoreMasked() {
    for (const element of mutedElements) {
      const record = maskRecords.get(element);
      try {
        if (
          record &&
          element.isConnected &&
          element.textContent === record.output
        ) {
          element.textContent = record.input;
        }
      } catch {
        /* element detached */
      }
    }
    mutedElements.clear();
  }

  // --- Panel ----------------------------------------------------------------

  const PANEL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7.5 3v5.7c0 4.7-3.1 8.4-7.5 10.3-4.4-1.9-7.5-5.6-7.5-10.3V5.5l7.5-3z" fill="currentColor" opacity=".18"/><path d="M12 4.2l5.8 2.3v4.7c0 3.8-2.4 6.8-5.8 8.4-3.4-1.6-5.8-4.6-5.8-8.4V6.5L12 4.2z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.4 11.6l1.8 1.8 3.6-3.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function panelMarkup() {
    return `
      <div class="cv-shell">
        <section id="cv-panel" class="cv-panel" data-ref="panel" aria-label="CleanVid">
          <header class="cv-header">
            <div class="cv-brand">
              <span class="cv-logo">${PANEL_ICON}</span>
              <span class="cv-brand-text"><strong>CleanVid</strong><span data-ref="mode">audio + caption filter</span></span>
            </div>
            <div class="cv-header-right">
              <span class="cv-pill" data-ref="pill"><span class="cv-dot"></span><span data-ref="status">Idle</span></span>
              <button class="cv-icon" type="button" data-action="collapse" title="Collapse CleanVid" aria-label="Collapse CleanVid">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
          </header>
          <div class="cv-body">
            <p class="cv-video-title" data-ref="title">Waiting for a video…</p>
            <div class="cv-progress">
              <div class="cv-progress-meta"><span data-ref="stage">Idle</span><span data-ref="percent">0%</span></div>
              <div class="cv-track"><div class="cv-fill" data-ref="bar"></div></div>
            </div>
            <div class="cv-audio" data-ref="audioBox" hidden>
              <ol class="cv-stages" aria-label="Audio pipeline">
                <li class="cv-stage" data-ref="stCapture"><span class="cv-stage-dot"></span>Capture</li>
                <li class="cv-stage" data-ref="stTranscribe"><span class="cv-stage-dot"></span>Transcribe</li>
                <li class="cv-stage" data-ref="stAlign"><span class="cv-stage-dot"></span>Align</li>
                <li class="cv-stage" data-ref="stDetect"><span class="cv-stage-dot"></span>Mute</li>
              </ol>
              <div class="cv-audio-meta">
                <span data-ref="audioText">Listening…</span>
                <span data-ref="audioAhead"></span>
              </div>
            </div>
            <div class="cv-setup" data-ref="setupBox" hidden>
              <div>
                <strong>Catch every swear word</strong>
                <span data-ref="setupText">Captions miss many of them. Install the on-device speech models (≈ 175–300 MB, once).</span>
              </div>
              <button class="cv-setup-btn" type="button" data-action="setup">Set up</button>
            </div>
            <div class="cv-stats">
              <div class="cv-count-wrap">
                <span class="cv-count" data-ref="count">—</span>
                <span class="cv-count-label">flagged</span>
              </div>
              <div class="cv-meta">
                <span data-ref="source">No captions loaded</span>
                <span data-ref="duration"></span>
              </div>
            </div>
            <div class="cv-controls">
              <label class="cv-switch"><input type="checkbox" data-ref="mute"><span class="cv-switch-ui"></span><span>Mute audio</span></label>
              <label class="cv-switch"><input type="checkbox" data-ref="mask"><span class="cv-switch-ui"></span><span>Mask captions</span></label>
            </div>
            <div class="cv-timeline" data-ref="timeline" hidden>
              <div class="cv-timeline-track"></div>
              <div class="cv-coverage" data-ref="coverage"></div>
              <div class="cv-playhead" data-ref="playhead"></div>
              <div class="cv-ticks" data-ref="ticks"></div>
            </div>
            <div class="cv-list-head" data-ref="listHead" hidden><button class="cv-textbtn" type="button" data-ref="listToggle" data-action="toggle-list" aria-expanded="false" aria-controls="cv-word-list">Show flagged words</button><button class="cv-textbtn" type="button" data-action="rescan">Re-scan</button></div>
            <div id="cv-word-list" class="cv-list" data-ref="list" hidden></div>
            <div class="cv-empty" data-ref="empty">
              <span class="cv-empty-icon" data-ref="emptyIcon">◎</span>
              <p data-ref="emptyText">Waiting for the player…</p>
              <button class="cv-textbtn" type="button" data-action="rescan" data-ref="retry" hidden>Re-scan</button>
            </div>
          </div>
          <footer class="cv-footer">
            <button class="cv-textbtn" type="button" data-action="options">Settings</button>
            <button class="cv-textbtn" type="button" data-ref="enabled" data-action="toggle-enabled">Pause</button>
            <span data-ref="footNote"></span>
          </footer>
        </section>
        <button class="cv-fab" type="button" data-ref="fab" data-action="toggle-panel" title="Collapse CleanVid" aria-label="Collapse CleanVid" aria-expanded="true" aria-controls="cv-panel">
          ${PANEL_ICON}
          <span class="cv-fab-count" data-ref="fabCount">0</span>
        </button>
      </div>`;
  }

  function ensurePanel() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'cleanvid-root';
    host.setAttribute('data-cleanvid', '');

    shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    try {
      link.href = chrome.runtime.getURL('src/content/panel.css');
    } catch {
      /* extension context invalidated */
    }
    shadow.appendChild(link);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = panelMarkup();
    shadow.appendChild(wrapper);

    refs = {};
    for (const node of shadow.querySelectorAll('[data-ref]')) {
      refs[node.dataset.ref] = node;
    }
    bindPanelEvents();
    (document.documentElement || document.body).appendChild(host);
    setCollapsed(Boolean(settings.panelCollapsed), false);
  }

  function bindPanelEvents() {
    shadow.addEventListener('click', (event) => {
      const actionNode = event.target.closest('[data-action]');
      if (actionNode) {
        const action = actionNode.dataset.action;
        if (action === 'collapse') setCollapsed(true);
        else if (action === 'toggle-panel') setCollapsed(!collapsed);
        else if (action === 'toggle-list') {
          listExpanded = !listExpanded;
          render();
        } else if (action === 'toggle-enabled') updateSetting({ enabled: !settings.enabled });
        else if (action === 'rescan') rescan();
        else if (action === 'options') openOptions();
        else if (action === 'setup') openOnboarding();
        return;
      }
      const row = event.target.closest('[data-seek]');
      if (row) seekTo(Number(row.dataset.seek));
    });

    shadow.addEventListener('change', (event) => {
      const input = event.target;
      if (input.dataset.ref === 'mute') updateSetting({ muteAudio: input.checked });
      if (input.dataset.ref === 'mask') updateSetting({ maskCaptions: input.checked });
    });
  }

  function setCollapsed(value, persist = true) {
    collapsed = Boolean(value);
    settings.panelCollapsed = collapsed;
    if (host) host.classList.toggle('cv-collapsed', collapsed);
    if (refs.fab) {
      refs.fab.setAttribute('aria-expanded', String(!collapsed));
      refs.fab.title = refs.fab.ariaLabel = collapsed ? 'Open CleanVid' : 'Collapse CleanVid';
    }
    if (persist) {
      saveSettings({ panelCollapsed: collapsed }).catch(() => {});
    }
  }

  function updateSetting(patch) {
    settings = { ...settings, ...patch };
    applyRuntimeSettings();
    saveSettings(patch).catch(() => {});
  }

  function applyRuntimeSettings() {
    if (settings.panelCollapsed !== collapsed) {
      setCollapsed(Boolean(settings.panelCollapsed), false);
    }
    setMasking(Boolean(settings.enabled && settings.maskCaptions));
    if (!settings.enabled || !settings.muteAudio) restoreMute();
    else checkMute(true);
    if (audioWanted()) ensureEngine();
    else if (engine) stopAudio();
    sendGainIntervals();
    render();
  }

  const BUSY_STAGES = new Set(['decoding', 'transcribing', 'aligning']);

  function audioReady() {
    return audioWanted() && audio.model.status === 'ready';
  }

  function audioCoveragePercent() {
    if (!(state.duration > 0)) return 0;
    return Math.min(100, (Timeline.total(audio.coverage) / state.duration) * 100);
  }

  function audioComplete() {
    return state.duration > 0 && Timeline.total(audio.coverage) >= state.duration - 1.5;
  }

  function displayStatus() {
    if (!settings.enabled) return 'paused';
    if (!audioReady()) return state.status;
    if (BUSY_STAGES.has(audio.stage) || audio.autoPause) return 'analyzing';
    if (state.status === 'loading' || state.status === 'analyzing') return state.status;
    return 'ready';
  }

  function render() {
    if (!host) return;
    host.hidden = !state.videoId;
    if (!refs.panel) return;

    const enabled = Boolean(settings.enabled);
    const status = displayStatus();
    const audioOn = enabled && audioReady();
    host.dataset.status = status;
    host.dataset.audio = audioOn ? 'on' : 'off';
    host.dataset.muting = host.dataset.muting === 'true' ? 'true' : 'false';

    refs.title.textContent = state.title || 'YouTube video';
    refs.title.title = state.title || '';
    refs.mode.textContent = audioOn ? 'audio + caption filter' : 'caption filter';

    let statusText = {
      idle: 'Idle',
      waiting: 'Waiting',
      loading: 'Loading',
      analyzing: 'Analyzing',
      ready: 'Ready',
      empty: 'No captions',
      error: 'Error',
      paused: 'Paused',
    }[status] || 'Idle';
    if (audioOn && status !== 'paused') {
      statusText = audio.autoPause ? 'Preparing' : audioComplete() ? 'Ready' : 'Listening';
    }
    refs.status.textContent = statusText;
    refs.pill.title = state.stage || statusText;

    if (audioOn) {
      const pct = audioCoveragePercent();
      refs.stage.textContent = audio.autoPause
        ? 'Analyzing the next moments before playing…'
        : audioComplete()
          ? 'Whole video analyzed'
          : 'Audio analyzed';
      refs.percent.textContent = state.duration > 0 ? `${Math.round(pct)}%` : '';
      refs.bar.style.width = `${pct}%`;
    } else {
      const progress = clampProgress(state.progress);
      refs.stage.textContent = state.stage || 'Ready';
      refs.percent.textContent = `${Math.round(progress)}%`;
      refs.bar.style.width = `${progress}%`;
    }

    const hasOccurrences = state.occurrences.length > 0;
    const countKnown = status === 'ready' || audioOn || (hasOccurrences && status !== 'paused');
    refs.count.textContent = countKnown ? String(state.occurrences.length) : '—';

    const durationText = state.duration > 0 ? formatTime(state.duration) : '';
    const sources = [];
    if (audioOn) sources.push(audio.model.device === 'webgpu' ? 'Audio (GPU)' : 'Audio (CPU)');
    if (state.source) sources.push(state.source);
    refs.source.textContent =
      sources.join(' + ') ||
      (state.status === 'waiting' ? 'Finding caption tracks…' : '—');
    refs.source.title = refs.source.textContent;
    refs.duration.textContent = durationText;

    refs.mute.checked = Boolean(settings.muteAudio);
    refs.mask.checked = Boolean(settings.maskCaptions);

    refs.timeline.hidden = !(hasOccurrences || audioOn);
    refs.listHead.hidden = !hasOccurrences;
    refs.empty.hidden = hasOccurrences;
    refs.list.hidden = !hasOccurrences || !listExpanded;
    refs.listToggle.textContent = `${listExpanded ? 'Hide' : 'Show'} flagged words (${state.occurrences.length})`;
    refs.listToggle.setAttribute('aria-expanded', String(listExpanded));
    refs.enabled.textContent = enabled ? 'Pause' : 'Resume';
    refs.enabled.setAttribute('aria-label', enabled ? 'Pause CleanVid' : 'Resume CleanVid');

    let emptyText = 'Waiting for the player…';
    let emptyIcon = '◎';
    let showRetry = false;
    const captionsBusy = state.status === 'loading' || state.status === 'analyzing';
    if (!enabled) {
      emptyText = 'CleanVid is paused. Turn it back on to scan this video.';
      emptyIcon = 'Ⅱ';
    } else if (audioOn && audioComplete() && !captionsBusy) {
      emptyText = 'Clean! No flagged words were heard in this video.';
      emptyIcon = '✓';
      showRetry = true;
    } else if (audioOn) {
      emptyText = audio.coverage.length
        ? 'Listening… nothing flagged so far.'
        : 'Listening to the audio as the player buffers it…';
      emptyIcon = '◌';
    } else if (state.status === 'loading') {
      emptyText = state.stage || 'Loading captions…';
      emptyIcon = '◌';
    } else if (state.status === 'analyzing') {
      emptyText = 'Scanning caption lines for flagged words…';
      emptyIcon = '◌';
    } else if (state.status === 'ready' && !hasOccurrences) {
      emptyText = 'Clean! No flagged words were found in the captions.';
      emptyIcon = '✓';
      showRetry = true;
    } else if (state.status === 'empty' || state.status === 'error') {
      emptyText = state.error || 'No captions could be analyzed.';
      emptyIcon = '!';
      showRetry = true;
    } else if (state.status === 'waiting') {
      emptyText = 'Waiting for the YouTube player to expose captions…';
    }
    refs.emptyText.textContent = emptyText;
    refs.emptyIcon.textContent = emptyIcon;
    refs.retry.hidden = !showRetry;

    const spoken = audio.words.length;
    refs.footNote.textContent = `${words.length} watched ${pluralize(words.length, 'word')}${
      spoken ? ` · ${spoken} heard` : state.cueCount ? ` · ${state.cueCount} lines` : ''
    }`;

    if (renderedListVersion !== listVersion) {
      renderedListVersion = listVersion;
      renderList();
      currentRow = -1;
    }
    const timelineKey = `${listVersion}|${Math.round(state.duration * 10)}`;
    if (renderedTimelineKey !== timelineKey) {
      renderedTimelineKey = timelineKey;
      renderTimeline();
    }

    let badgeCount = '';
    if (countKnown) badgeCount = state.occurrences.length > 99 ? '99+' : String(state.occurrences.length);
    else if (status === 'loading' || status === 'analyzing') badgeCount = '…';
    refs.fabCount.textContent = badgeCount;
    refs.fabCount.hidden = !badgeCount;
    renderAudio();
    highlightCurrent(watchedVideo ? watchedVideo.currentTime : 0);
  }

  let renderedCoverageKey = '';

  function setStage(node, value) {
    if (node && node.dataset.state !== value) node.dataset.state = value;
  }

  /** Audio pipeline chips, coverage bar and setup prompt. */
  function renderAudio() {
    if (!refs.audioBox) return;
    const wanted = audioWanted();
    const status = audio.model.status;
    const showSetup = wanted && (status === 'missing' || status === 'error');
    refs.setupBox.hidden = !showSetup;
    if (showSetup) {
      refs.setupText.textContent = status === 'error'
        ? `The speech models could not load (${audio.model.error || 'unknown error'}). Open setup to retry.`
        : 'Captions miss many of them. Install the on-device speech models (≈ 175–300 MB, once).';
    }
    const visible = wanted && (status === 'ready' || status === 'loading' || status === 'installed');
    refs.audioBox.hidden = !visible;
    if (!visible) {
      if (refs.coverage) refs.coverage.textContent = '';
      renderedCoverageKey = '';
      return;
    }

    const t = watchedVideo ? watchedVideo.currentTime || 0 : 0;
    const busy = BUSY_STAGES.has(audio.stage);
    const hasAudio = audio.available.length > 0 || audio.coverage.length > 0;
    const recentlyDetected = Date.now() - audio.lastChunkAt < 1200;

    if (status !== 'ready') {
      const p = audio.model.progress || {};
      const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
      refs.audioText.textContent = status === 'loading'
        ? `Loading speech models${pct && pct < 100 ? ` · ${pct}%` : '…'}`
        : 'Starting speech models…';
      refs.audioAhead.textContent = '';
      for (const ref of ['stTranscribe', 'stAlign', 'stDetect']) setStage(refs[ref], 'idle');
      setStage(refs.stCapture, hasAudio ? 'done' : 'active');
    } else {
      setStage(refs.stCapture, hasAudio ? 'done' : 'active');
      setStage(
        refs.stTranscribe,
        audio.stage === 'transcribing' || audio.stage === 'decoding' ? 'active' : audio.coverage.length ? 'done' : 'idle'
      );
      setStage(refs.stAlign, audio.stage === 'aligning' ? 'active' : audio.coverage.length ? 'done' : 'idle');
      setStage(refs.stDetect, recentlyDetected ? 'active' : audio.coverage.length ? 'done' : 'idle');

      const ahead = Timeline.aheadOf(audio.coverage, t);
      let text;
      if (audio.error && !busy) text = 'A stretch could not be analyzed; captions cover it.';
      else if (busy && audio.stageRange) {
        const verb = audio.stage === 'aligning' ? 'Aligning' : 'Transcribing';
        text = `${verb} ${formatTime(audio.stageRange[0])}–${formatTime(audio.stageRange[1])}`;
      } else if (!hasAudio) text = 'Waiting for the player to buffer audio…';
      else if (audioComplete()) text = 'Every word of this video is analyzed';
      else text = 'Waiting for more audio from the player…';
      refs.audioText.textContent = text;
      let aheadText = '';
      if (ahead > 0.5) aheadText = `${formatTime(ahead)} ahead`;
      else if (hasAudio && !audioComplete() && Timeline.contains(audio.available, t, 0.3)) aheadText = 'catching up';
      refs.audioAhead.textContent = aheadText;
      refs.audioAhead.title = audio.rtf ? `${audio.rtf}× real time` : '';
    }

    // Coverage bar on the timeline.
    const duration = state.duration > 0 ? state.duration : 0;
    if (!refs.coverage || !duration) return;
    if (refs.playhead) refs.playhead.style.left = `${Math.min(100, (t / duration) * 100)}%`;
    const key = [
      audio.coverage.map((r) => `${r[0].toFixed(1)}-${r[1].toFixed(1)}`).join(','),
      audio.available.map((r) => `${r[0].toFixed(0)}-${r[1].toFixed(0)}`).join(','),
      busy && audio.stageRange ? audio.stageRange.join('-') : '',
      Math.round(duration),
    ].join('|');
    if (key === renderedCoverageKey) return;
    renderedCoverageKey = key;
    refs.coverage.textContent = '';
    const fragment = document.createDocumentFragment();
    const add = (range, className) => {
      const el = document.createElement('span');
      el.className = className;
      const left = Math.max(0, Math.min(100, (range[0] / duration) * 100));
      const right = Math.max(0, Math.min(100, (range[1] / duration) * 100));
      el.style.left = `${left}%`;
      el.style.width = `${Math.max(0.4, right - left)}%`;
      fragment.append(el);
    };
    for (const range of Timeline.subtract(audio.available, audio.coverage)) add(range, 'cv-cov is-buffered');
    for (const range of audio.coverage) add(range, 'cv-cov is-done');
    if (busy && audio.stageRange) add(audio.stageRange, 'cv-cov is-working');
    refs.coverage.append(fragment);
    refs.coverage.title = `${Math.round(audioCoveragePercent())}% of the audio analyzed`;
  }

  function renderList() {
    if (!refs.list) return;
    refs.list.textContent = '';
    const fragment = document.createDocumentFragment();
    const total = Math.min(state.occurrences.length, MAX_LIST_ROWS);
    for (let i = 0; i < total; i++) {
      const occurrence = state.occurrences[i];
      const wrapper = document.createElement('div');
      wrapper.className = 'cv-row-wrap';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cv-row';
      row.dataset.seek = String(occurrence.start);
      row.title = `Jump to ${formatTime(occurrence.start)}`;
      const time = document.createElement('span');
      time.className = 'cv-row-time';
      time.textContent = formatTime(occurrence.at ?? occurrence.start);
      const word = document.createElement('span');
      word.className = 'cv-row-word';
      word.textContent = maskLabel(occurrence.text);
      const rule = document.createElement('span');
      rule.className = 'cv-row-rule';
      rule.dataset.source = occurrence.source || 'captions';
      rule.textContent = occurrenceLabel(occurrence);
      rule.title = occurrenceTitle(occurrence);
      row.append(time, word, rule);
      wrapper.append(row);
      fragment.append(wrapper);
    }
    if (state.occurrences.length > total) {
      const more = document.createElement('div');
      more.className = 'cv-more';
      more.textContent = `+${state.occurrences.length - total} more moments`;
      fragment.append(more);
    }
    refs.list.append(fragment);
  }

  function renderTimeline() {
    if (!refs.ticks) return;
    refs.ticks.textContent = '';
    const duration =
      state.duration > 0
        ? state.duration
        : Math.max(1, ...state.occurrences.map((item) => item.end));
    if (!duration || !state.occurrences.length) return;
    const fragment = document.createDocumentFragment();
    for (const occurrence of state.occurrences.slice(0, 400)) {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'cv-tick';
      tick.dataset.seek = String(occurrence.start);
      const displayTime = occurrence.at ?? occurrence.start;
      tick.style.left = `${Math.min(100, Math.max(0, (displayTime / duration) * 100))}%`;
      const label = maskLabel(occurrence.text);
      tick.title = `${formatTime(displayTime)} · ${label}`;
      tick.setAttribute(
        'aria-label',
        `Flagged word at ${formatTime(displayTime)}`
      );
      fragment.append(tick);
    }
    refs.ticks.append(fragment);
  }

  function seekTo(time) {
    const target = Number(time);
    if (!Number.isFinite(target) || target < 0) return;
    const video = findVideo();
    if (!video) return;
    bindVideo(video);
    try {
      video.currentTime = target;
      const promise = video.play();
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch {
      /* ignore */
    }
    checkMute(true);
  }

  function openOnboarding() {
    try {
      chrome.runtime.sendMessage({ type: 'open-onboarding' }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* extension reloaded */
    }
  }

  function openOptions() {
    try {
      chrome.runtime.openOptionsPage();
    } catch {
      try {
        chrome.runtime.sendMessage({ type: 'open-options' });
      } catch {
        /* ignore */
      }
    }
  }

  function updateBadge() {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'set-badge',
          status: settings.enabled ? state.status : 'paused',
          count: state.occurrences.length,
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch {
      /* extension reloaded */
    }
  }

  function getPublicState() {
    return {
      ok: true,
      onWatchPage: Boolean(state.videoId),
      videoId: state.videoId,
      title: state.title,
      status: settings.enabled ? state.status : 'paused',
      rawStatus: state.status,
      stage: state.stage,
      progress: clampProgress(state.progress),
      source: state.source,
      count: state.occurrences.length,
      duration: state.duration,
      enabled: Boolean(settings.enabled),
      muteAudio: Boolean(settings.muteAudio),
      maskCaptions: Boolean(settings.maskCaptions),
      sensitivity: settings.sensitivity,
      wordsCount: words.length,
      captions: state.tracks.length,
      muted: (mute.applied && !mute.userMuted) || (audio.gainReady && host && host.dataset.muting === 'true'),
      error: state.error,
      displayStatus: displayStatus(),
      audio: {
        wanted: audioWanted(),
        model: audio.model.status,
        pack: audio.model.pack,
        device: audio.model.device,
        coverage: Math.round(audioCoveragePercent()),
        complete: audioComplete(),
        ahead: Math.round(Timeline.aheadOf(audio.coverage, watchedVideo ? watchedVideo.currentTime : 0)),
        stage: audio.stage,
        words: audio.words.length,
        gain: audio.gainReady,
        prefetch: audio.prefetch,
      },
      occurrences: state.occurrences.slice(0, 40).map((occurrence) => ({
        start: Math.round(occurrence.start * 100) / 100,
        end: Math.round(occurrence.end * 100) / 100,
        label: maskLabel(occurrence.text),
        time: formatTime(occurrence.start),
        rule: occurrence.rule,
        source: occurrence.source || 'captions',
      })),
    };
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'GET_STATE') {
      sendResponse(getPublicState());
      return;
    }
    if (message.type === 'RESCAN') {
      rescan();
      sendResponse(getPublicState());
      return;
    }
    if (message.type === 'SEEK') {
      seekTo(message.time);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'TOGGLE_PANEL') {
      if (!state.videoId) {
        sendResponse({ ok: false });
        return;
      }
      ensurePanel();
      setCollapsed(!collapsed);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'SET_PANEL') {
      setCollapsed(Boolean(message.collapsed));
      sendResponse({ ok: true });
      return;
    }
  }

  // --- Settings and init ----------------------------------------------------

  function refreshMatcher() {
    matcher = Matcher.buildIndex(words, settings.sensitivity);
  }

  const onStorageChanged = debounce(async () => {
    const previousSensitivity = settings.sensitivity;
    const previousWords = words.join('\u0001');
    const previousPadding = settings.mutePaddingMs;
    const previousLanguage = settings.captionLanguage;
    const previousTranslation = settings.tryYouTubeTranslation;
    const previousOpenSubtitles = settings.useOpenSubtitles;
    const previousAudioPadding = settings.audioPaddingMs;
    try {
      const previousOpenSubtitlesKey = await constants.getOpenSubtitlesKey();
      settings = await constants.getSettings();
      const data = await constants.getWordData();
      const currentOpenSubtitlesKey = await constants.getOpenSubtitlesKey();
      const wordsChanged = data.words.join('\u0001') !== previousWords;
      const sensitivityChanged = settings.sensitivity !== previousSensitivity;
      const paddingChanged = settings.mutePaddingMs !== previousPadding;
      const audioPaddingChanged = settings.audioPaddingMs !== previousAudioPadding;
      const languageChanged = settings.captionLanguage !== previousLanguage;
      const sourceChanged =
        settings.tryYouTubeTranslation !== previousTranslation ||
        settings.useOpenSubtitles !== previousOpenSubtitles ||
        (settings.useOpenSubtitles && currentOpenSubtitlesKey !== previousOpenSubtitlesKey);
      words = data.words;
      if (wordsChanged || sensitivityChanged) {
        refreshMatcher();
      }
      applyRuntimeSettings();
      if ((languageChanged || sourceChanged) && state.videoId) {
        if (state.status === 'loading' || state.status === 'analyzing') {
          runningToken++;
          state.status = 'waiting';
        }
        startAnalysis();
        return;
      }
      if ((wordsChanged || sensitivityChanged) && state.cues.length) {
        analyzeCues(state.cues, ++runningToken);
        return;
      }
      if (wordsChanged || sensitivityChanged) {
        // Saved transcripts are simply re-matched — no new speech recognition.
        audio.occurrenceKey = '';
        recombine();
      }
      if ((paddingChanged || audioPaddingChanged) && state.occurrences.length) {
        state.intervals = buildIntervals(state.occurrences, settings.mutePaddingMs, settings.audioPaddingMs);
        sendGainIntervals();
        checkMute(true);
      }
      updateBadge();
    } catch {
      /* extension context invalidated */
    }
  }, 250);

  async function init() {
    try {
      const [storedSettings, wordData] = await Promise.all([
        constants.getSettings(),
        constants.getWordData(),
      ]);
      settings = { ...DEFAULT_SETTINGS, ...storedSettings };
      words = wordData.words;
    } catch {
      settings = { ...DEFAULT_SETTINGS };
      words = [...constants.DEFAULT_WORDS];
    }
    refreshMatcher();
    ensurePanel();
    applyRuntimeSettings();

    window.addEventListener('message', onBridgeMessage);
    document.addEventListener('yt-navigate-finish', () => {
      onNavigate();
      setTimeout(onNavigate, 250);
    });
    document.addEventListener('yt-page-data-updated', onNavigate);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);

    try {
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (
          changes[STORAGE_KEYS.settings] ||
          changes[STORAGE_KEYS.words] ||
          changes[STORAGE_KEYS.openSubtitlesKey]
        ) {
          onStorageChanged();
        }
      });
    } catch {
      /* extension context invalidated */
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkMute(true);
    });
    setInterval(() => {
      // The fallback mute path must keep working in background tabs too.
      checkMute();
      checkAutoPause();
      sendPlayhead(false);
    }, 120);
    setInterval(() => {
      if (!document.hidden) renderAudio();
    }, 1000);
    setInterval(onNavigate, 1200);

    onNavigate();
  }

  init();
})();
