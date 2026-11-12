/**
 * CleanVid — MAIN-world bridge.
 *
 * YouTube often serves /api/timedtext only to its own player (signed URLs
 * include a short-lived `pot` token), so a plain extension fetch can come back
 * empty. This script runs in the page's JavaScript world and:
 *
 *   1. exposes the current player's caption tracks,
 *   2. tries a direct timedtext fetch,
 *   3. reuses a timedtext response the player itself already fetched,
 *   4. briefly enables the desired caption track to make the player fetch it,
 *      captures that response, then restores the user's caption state.
 *
 * It communicates with the isolated-world content script through postMessage.
 */
(() => {
  const BRIDGE_SOURCE = 'cleanvid-bridge';
  const CONTENT_SOURCE = 'cleanvid-content';
  if (window.__cleanvidBridgeInstalled) return;
  window.__cleanvidBridgeInstalled = true;

  const captures = [];
  const MAX_CAPTURES = 16;
  const captureBus = new EventTarget();
  let lastSignature = '';
  let scanTimer = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeUrl(value) {
    try {
      return new URL(String(value || ''), location.origin).href;
    } catch {
      return String(value || '');
    }
  }

  function isTimedText(value) {
    if (!value) return false;
    try {
      const url = new URL(String(value), location.origin);
      return (
        /(^|\.)youtube\.com$/i.test(url.hostname) &&
        url.pathname === '/api/timedtext'
      );
    } catch {
      return false;
    }
  }

  function recordCapture(url, text) {
    if (!isTimedText(url)) return;
    if (!text || typeof text !== 'string' || text.trim().length < 2) return;
    const now = Date.now();
    const normalized = normalizeUrl(url);
    const duplicate = captures.some(
      (item) =>
        item.url === normalized && item.text === text && now - item.at < 5000
    );
    if (duplicate) return;
    captures.push({ url: normalized, text, at: now });
    while (captures.length > MAX_CAPTURES) captures.shift();
    captureBus.dispatchEvent(new Event('capture'));
  }

  // --- Capture the player's own timedtext traffic ---------------------------

  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function cleanvidFetch(input, init) {
        const url =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
              ? input.url
              : '';
        const promise = originalFetch.apply(this, arguments);
        if (isTimedText(url) && promise && typeof promise.then === 'function') {
          promise
            .then((response) => {
              if (!response || !response.ok) return;
              try {
                response
                  .clone()
                  .text()
                  .then((text) => recordCapture(url, text))
                  .catch(() => {});
              } catch {
                /* body already consumed */
              }
            })
            .catch(() => {});
        }
        return promise;
      };
    }
  } catch {
    /* page may have frozen fetch */
  }

  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;
      XHR.prototype.open = function cleanvidOpen(method, url) {
        try {
          this.__cleanvidUrl = typeof url === 'string' ? url : String(url || '');
        } catch {
          this.__cleanvidUrl = '';
        }
        return originalOpen.apply(this, arguments);
      };
      XHR.prototype.send = function cleanvidSend() {
        const url = this.__cleanvidUrl;
        if (isTimedText(url)) {
          this.addEventListener('load', () => {
            try {
              const type = this.responseType;
              if (!type || type === 'text') {
                recordCapture(url, this.responseText);
              } else if (type === 'json' && this.response) {
                recordCapture(url, JSON.stringify(this.response));
              }
            } catch {
              /* responseType may disallow responseText */
            }
          });
        }
        return originalSend.apply(this, arguments);
      };
    }
  } catch {
    /* page may have frozen XMLHttpRequest */
  }

  // --- Player discovery -----------------------------------------------------

  function getPlayer() {
    const direct = document.getElementById('movie_player');
    if (direct) return direct;
    return document.querySelector('.html5-video-player');
  }

  function getPlayerResponse() {
    let response = null;
    try {
      const player = getPlayer();
      if (player && typeof player.getPlayerResponse === 'function') {
        response = player.getPlayerResponse();
      }
    } catch {
      response = null;
    }
    if (!response || !response.videoDetails) {
      try {
        response = window.ytInitialPlayerResponse || null;
      } catch {
        response = null;
      }
    }
    if (!response || !response.videoDetails) {
      try {
        const raw = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args
          ? window.ytplayer.config.args.player_response
          : null;
        if (raw) response = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        response = null;
      }
    }
    return response || null;
  }

  function getUrlVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const live = url.pathname.match(/^\/live\/([\w-]+)/);
      return live ? live[1] : null;
    } catch {
      return null;
    }
  }

  function readTracks(response) {
    const list =
      response &&
      response.captions &&
      response.captions.playerCaptionsTracklistRenderer &&
      response.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!Array.isArray(list)) return [];
    return list
      .filter((track) => track && track.baseUrl)
      .map((track) => ({
        languageCode: track.languageCode || '',
        kind: track.kind || '',
        vssId: track.vssId || '',
        name: track.name || null,
        baseUrl: normalizeUrl(track.baseUrl),
        isTranslatable: Boolean(track.isTranslatable),
      }));
  }

  function buildPayload() {
    const response = getPlayerResponse();
    const urlId = getUrlVideoId();
    const details = (response && response.videoDetails) || {};
    const videoId = details.videoId || urlId;
    const stale = Boolean(details.videoId && urlId && details.videoId !== urlId);
    const tracks = stale ? [] : readTracks(response);
    return {
      videoId: videoId || urlId,
      urlVideoId: urlId,
      title:
        (!stale && details.title) ||
        String(document.title || '').replace(/\s*-\s*YouTube\s*$/i, ''),
      duration: (!stale && Number(details.lengthSeconds)) || 0,
      tracks,
      at: Date.now(),
    };
  }

  function post(message) {
    try {
      window.postMessage(message, location.origin);
    } catch {
      try {
        window.postMessage(message, '*');
      } catch {
        /* detached frame */
      }
    }
  }

  function sendPlayerData(force = false) {
    const payload = buildPayload();
    const signature = [
      payload.videoId || '',
      payload.title || '',
      payload.duration || 0,
      payload.tracks.map((track) => `${track.languageCode}:${track.kind}:${track.vssId}`).join(','),
    ].join('|');
    if (!force && signature === lastSignature) return payload;
    lastSignature = signature;
    post({ source: BRIDGE_SOURCE, type: 'player', payload });
    return payload;
  }

  // --- Caption retrieval ----------------------------------------------------

  function parseCaptureUrl(value) {
    try {
      const url = new URL(value, location.origin);
      return {
        lang: url.searchParams.get('lang') || '',
        tlang: url.searchParams.get('tlang') || '',
        kind: url.searchParams.get('kind') || '',
        videoId: url.searchParams.get('v') || '',
      };
    } catch {
      return { lang: '', tlang: '', kind: '', videoId: '' };
    }
  }

  function languageMatches(a, b) {
    if (!a || !b) return false;
    const left = String(a).toLowerCase();
    const right = String(b).toLowerCase();
    return (
      left === right ||
      left.startsWith(`${right}-`) ||
      right.startsWith(`${left}-`) ||
      left.split('-')[0] === right.split('-')[0]
    );
  }

  function captureMatches(capture, track, videoId) {
    const meta = parseCaptureUrl(capture.url);
    if (meta.videoId && videoId && meta.videoId !== videoId) return false;
    // Do not reuse an auto-generated response for a manual track (or vice
    // versa), and never treat an auto-translation response as the source text.
    if (meta.tlang) return false;
    if ((meta.kind || '') !== (track.kind || '')) return false;
    if (track.languageCode) {
      const language = meta.tlang || meta.lang;
      if (language && !languageMatches(language, track.languageCode)) return false;
    }
    return true;
  }

  function findCaptured(track, videoId, fromIndex = 0) {
    const now = Date.now();
    for (let i = captures.length - 1; i >= fromIndex; i--) {
      const capture = captures[i];
      if (!capture || now - capture.at > 180000) continue;
      if (capture.text.trim() && captureMatches(capture, track, videoId)) {
        return capture;
      }
    }
    return null;
  }

  function looksLikeHtml(text) {
    const head = text.slice(0, 300).trim().toLowerCase();
    return head.startsWith('<!doctype html') || head.includes('<html');
  }

  async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await window.fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response || !response.ok) return null;
      const text = await response.text();
      if (!text || text.trim().length < 2 || looksLikeHtml(text)) return null;
      return text;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchDirect(track, translationLanguage = '') {
    const formats = ['json3', 'srv3', ''];
    for (const format of formats) {
      let url;
      try {
        url = new URL(track.baseUrl, location.origin);
      } catch {
        return null;
      }
      url.searchParams.delete('fmt');
      if (translationLanguage) url.searchParams.set('tlang', translationLanguage);
      if (format) url.searchParams.set('fmt', format);
      const text = await fetchText(url.href);
      if (text) return { text, url: url.href, format: format || 'xml' };
    }
    return null;
  }

  function waitForPlayer(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        const player = getPlayer();
        if (player && typeof player.setOption === 'function') {
          resolve(player);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(check, 150);
      };
      check();
    });
  }

  function waitForCapture(track, videoId, timeoutMs, fromIndex) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        captureBus.removeEventListener('capture', onChange);
        resolve(value);
      };
      const check = () => {
        const capture = findCaptured(track, videoId, fromIndex);
        if (capture) finish(capture);
      };
      const onChange = () => check();
      const timer = setTimeout(() => finish(findCaptured(track, videoId, fromIndex) || null), timeoutMs);
      captureBus.addEventListener('capture', onChange);
      check();
    });
  }

  function trackOption(track) {
    const option = { languageCode: track.languageCode };
    if (track.kind) option.kind = track.kind;
    return option;
  }

  async function triggerCapture(track, videoId) {
    const player = await waitForPlayer(5000);
    if (!player) return null;

    let savedTrack = null;
    try {
      savedTrack = player.getOption('captions', 'track') || null;
    } catch {
      savedTrack = null;
    }

    const captionWindow = document.querySelector('.ytp-caption-window-container');
    const previousVisibility = captionWindow ? captionWindow.style.visibility : '';
    if (captionWindow) captionWindow.style.visibility = 'hidden';

    try {
      try {
        player.loadModule('captions');
      } catch {
        /* module may already be loaded */
      }

      const fromIndex = captures.length;
      const enable = () => {
        try {
          player.setOption('captions', 'track', trackOption(track));
        } catch {
          /* player rejected the track */
        }
      };

      const currentlySame =
        savedTrack &&
        savedTrack.languageCode &&
        languageMatches(savedTrack.languageCode, track.languageCode);
      if (currentlySame) {
        try {
          player.setOption('captions', 'track', {});
        } catch {
          /* ignore */
        }
        await delay(200);
      }

      enable();
      let capture = await waitForCapture(track, videoId, 5500, fromIndex);
      if (!capture) {
        try {
          player.setOption('captions', 'track', {});
        } catch {
          /* ignore */
        }
        await delay(250);
        enable();
        capture = await waitForCapture(track, videoId, 5000, fromIndex);
      }

      await delay(120);
      return capture;
    } finally {
      try {
        if (savedTrack && savedTrack.languageCode) {
          player.setOption('captions', 'track', savedTrack);
        } else {
          player.setOption('captions', 'track', {});
        }
      } catch {
        /* ignore */
      }
      if (captionWindow) captionWindow.style.visibility = previousVisibility;
    }
  }

  function success(text, source, url, additional = {}) {
    return { ok: true, data: { text, source, url, ...additional } };
  }

  async function requestCaptions(payload) {
    const track = payload && payload.track;
    if (!track || !track.baseUrl || !isTimedText(track.baseUrl)) {
      return { ok: false, error: 'No usable caption track was found.' };
    }
    const videoId = payload.videoId || getUrlVideoId();

    // The supplied signed URL is specific to this track, while a response
    // already used by the YouTube player is only matched by its URL fields.
    // Try the exact URL first to avoid substituting another same-language
    // track's transcript.
    const direct = await fetchDirect(track);
    const alreadyCaptured = direct ? null : findCaptured(track, videoId);
    const triggered = direct || alreadyCaptured ? null : await triggerCapture(track, videoId);
    const base = direct
      ? { ...direct, source: 'direct' }
      : alreadyCaptured
        ? { text: alreadyCaptured.text, url: alreadyCaptured.url, source: 'captured' }
        : triggered
          ? { text: triggered.text, url: triggered.url, source: 'player' }
          : null;

    if (!base) {
      return { ok: false, error: 'YouTube did not return caption data for this video.' };
    }

    let translation = null;
    const targetLanguage = String(payload.translationLanguage || '').trim().toLowerCase();
    if (targetLanguage && track.isTranslatable) {
      translation = await fetchDirect(track, targetLanguage);
    }
    return success(base.text, base.source, base.url, {
      translatedText: translation && translation.text ? translation.text : '',
      translatedUrl: translation && translation.url ? translation.url : '',
    });
  }

  // --- Audio capture (Media Source Extensions) -------------------------------
  //
  // The player hands every audio byte it buffers to SourceBuffer.appendBuffer,
  // regardless of how it fetched them (DASH, SABR/UMP, …). We copy audio
  // appends and forward them to the content script. A bounded replay buffer
  // covers appends that happen before the content script is listening.

  const audio = {
    enabled: true,
    listening: false,
    nextKey: 1,
    replay: [],
    replayBytes: 0,
    inits: new Map(), // key -> latest message whose bytes start with an init
  };
  const REPLAY_LIMIT = 24 * 1024 * 1024;
  const bufferInfo = new WeakMap(); // SourceBuffer -> { key, mime, mediaSource }

  function currentVideoId() {
    try {
      const player = getPlayer();
      const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      if (data && data.video_id) return data.video_id;
    } catch {
      /* ignore */
    }
    return getUrlVideoId();
  }

  function adShowing() {
    const player = getPlayer();
    return Boolean(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
  }

  function looksLikeInit(bytes) {
    if (bytes.length < 8) return false;
    // WebM EBML header or MP4 ftyp/moov
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
    const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    return type === 'ftyp' || type === 'moov';
  }

  function emitAudio(message, transfer) {
    if (audio.listening) {
      try {
        window.postMessage(message, location.origin, transfer);
      } catch {
        /* ignore */
      }
      return;
    }
    audio.replay.push(message);
    audio.replayBytes += message.bytes ? message.bytes.byteLength : 0;
    while (audio.replayBytes > REPLAY_LIMIT && audio.replay.length > 1) {
      const dropped = audio.replay.shift();
      audio.replayBytes -= dropped.bytes ? dropped.bytes.byteLength : 0;
    }
  }

  function captureAppend(sourceBuffer, data) {
    const info = bufferInfo.get(sourceBuffer);
    if (!info || !audio.enabled) return;
    let view;
    if (data instanceof ArrayBuffer) view = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return;
    if (!view.byteLength) return;
    const ad = adShowing();
    // Ads play through their own MediaSource with a short duration; skip them.
    let msDuration = 0;
    try {
      msDuration = info.mediaSource ? Number(info.mediaSource.duration) || 0 : 0;
    } catch {
      msDuration = 0;
    }
    const copy = view.slice();
    const message = {
      source: BRIDGE_SOURCE,
      type: 'audio',
      kind: 'append',
      key: info.key,
      mime: info.mime,
      videoId: currentVideoId(),
      offset: Number(sourceBuffer.timestampOffset) || 0,
      msDuration,
      ad,
      bytes: copy.buffer,
      at: Date.now(),
    };
    if (looksLikeInit(copy)) audio.inits.set(info.key, { ...message, bytes: copy.buffer.slice(0) });
    emitAudio(message, [copy.buffer]);
  }

  function hookMediaSource(MS) {
    if (!MS || !MS.prototype || MS.prototype.__cleanvidHooked) return;
    MS.prototype.__cleanvidHooked = true;
    const originalAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function cleanvidAddSourceBuffer(mime) {
      const sourceBuffer = originalAdd.apply(this, arguments);
      try {
        if (/^audio\//i.test(String(mime || ''))) {
          bufferInfo.set(sourceBuffer, { key: `sb${audio.nextKey++}`, mime: String(mime), mediaSource: this });
        }
      } catch {
        /* ignore */
      }
      return sourceBuffer;
    };
  }

  function hookSourceBuffer(SB) {
    if (!SB || !SB.prototype || SB.prototype.__cleanvidHooked) return;
    SB.prototype.__cleanvidHooked = true;
    const originalAppend = SB.prototype.appendBuffer;
    SB.prototype.appendBuffer = function cleanvidAppendBuffer(data) {
      try {
        captureAppend(this, data);
      } catch {
        /* never break playback */
      }
      return originalAppend.apply(this, arguments);
    };
    const originalAbort = SB.prototype.abort;
    if (typeof originalAbort === 'function') {
      SB.prototype.abort = function cleanvidAbort() {
        try {
          const info = bufferInfo.get(this);
          if (info) emitAudio({ source: BRIDGE_SOURCE, type: 'audio', kind: 'reset', key: info.key, videoId: currentVideoId() });
        } catch {
          /* ignore */
        }
        return originalAbort.apply(this, arguments);
      };
    }
  }

  try {
    hookMediaSource(window.MediaSource);
    hookMediaSource(window.ManagedMediaSource);
    hookSourceBuffer(window.SourceBuffer);
    hookSourceBuffer(window.ManagedSourceBuffer);
  } catch {
    /* MSE unavailable */
  }

  function startAudioListening() {
    if (audio.listening) return;
    audio.listening = true;
    // Replay what was captured before the content script was ready. Make sure
    // each buffer's init segment precedes its media.
    const queued = audio.replay;
    audio.replay = [];
    audio.replayBytes = 0;
    const keysWithInit = new Set();
    for (const message of queued) {
      if (message.kind === 'append' && message.bytes && looksLikeInit(new Uint8Array(message.bytes))) {
        keysWithInit.add(message.key);
      }
    }
    for (const [key, init] of audio.inits) {
      if (!keysWithInit.has(key)) {
        const copy = init.bytes.slice(0);
        post({ ...init, bytes: copy });
      }
    }
    for (const message of queued) post(message);
  }

  // --- Best-effort whole-video prefetch ----------------------------------------
  //
  // If the player response exposes a plain audio-only stream URL, fetch it in
  // the background so the whole video can be analysed early. YouTube usually
  // withholds or protects these URLs (SABR, n-parameter, PO tokens); any
  // failure simply stops the prefetch and buffered audio is used instead.

  const prefetch = { videoId: null, controller: null };

  function pickPrefetchFormat(response) {
    const formats =
      (response && response.streamingData && response.streamingData.adaptiveFormats) || [];
    const usable = formats.filter(
      (format) =>
        format &&
        typeof format.url === 'string' &&
        /^audio\//.test(String(format.mimeType || '')) &&
        Number(format.contentLength) > 0
    );
    usable.sort((a, b) => (Number(a.bitrate) || 0) - (Number(b.bitrate) || 0));
    // Prefer low-bitrate Opus; speech recognition does not need more.
    return usable.find((format) => /opus/.test(format.mimeType)) || usable[0] || null;
  }

  async function runPrefetch(videoId) {
    stopPrefetch();
    const response = getPlayerResponse();
    if (!response || !response.videoDetails || response.videoDetails.videoId !== videoId) {
      return { ok: false, reason: 'no-player-response' };
    }
    if (response.videoDetails.isLive) return { ok: false, reason: 'live' };
    const format = pickPrefetchFormat(response);
    if (!format) return { ok: false, reason: 'no-direct-url' };
    const controller = new AbortController();
    prefetch.videoId = videoId;
    prefetch.controller = controller;
    const key = `prefetch-${audio.nextKey++}`;
    const total = Number(format.contentLength);
    const step = 512 * 1024;
    let offset = 0;
    try {
      while (offset < total && !controller.signal.aborted) {
        if (currentVideoId() !== videoId) break;
        const end = Math.min(total, offset + step) - 1;
        const url = new URL(format.url);
        url.searchParams.set('range', `${offset}-${end}`);
        const res = await window.fetch(url.href, { signal: controller.signal, credentials: 'omit' });
        if (!res.ok) return { ok: false, reason: `http-${res.status}`, at: offset };
        const buffer = await res.arrayBuffer();
        if (!buffer.byteLength) return { ok: false, reason: 'empty', at: offset };
        post({
          source: BRIDGE_SOURCE,
          type: 'audio',
          kind: 'append',
          key,
          mime: String(format.mimeType),
          videoId,
          offset: 0,
          msDuration: 0,
          ad: false,
          bytes: buffer,
          prefetch: true,
          at: Date.now(),
        });
        offset += buffer.byteLength;
        // Be gentle with bandwidth while the user is watching.
        await delay(150);
      }
      return { ok: offset >= total, reason: offset >= total ? 'complete' : 'stopped', at: offset };
    } catch (error) {
      return { ok: false, reason: controller.signal.aborted ? 'aborted' : 'network', at: offset };
    } finally {
      if (prefetch.controller === controller) {
        prefetch.controller = null;
        prefetch.videoId = null;
      }
    }
  }

  function stopPrefetch() {
    if (prefetch.controller) {
      try {
        prefetch.controller.abort();
      } catch {
        /* ignore */
      }
    }
    prefetch.controller = null;
    prefetch.videoId = null;
  }

  // --- Sample-accurate muting (Web Audio) -----------------------------------------
  //
  // The video element is routed through a GainNode whose value is scheduled
  // against the AudioContext clock with short fades — no clicks, no timer
  // jitter. If YouTube itself creates a MediaElementSource for the video, our
  // gain is spliced into its graph instead. If Web Audio is unavailable, the
  // content script falls back to toggling video.muted.

  const gainState = {
    intervals: [],
    active: false, // content wants muting enabled
    style: 'silence',
    ctx: null,
    gain: null,
    bleepGain: null,
    oscillator: null,
    video: null,
    ownsSource: false,
    ready: false,
    failed: '',
    timer: null,
    lastKey: '',
  };
  const FADE = 0.008;
  // Boundaries are planned this far ahead on the audio clock, so muting stays
  // exact even when timers are throttled (background tabs run them ~1×/s).
  const LOOKAHEAD = 20;
  const elementSources = new WeakMap(); // HTMLMediaElement -> { ctx, gain }

  function reportGain() {
    post({
      source: BRIDGE_SOURCE,
      type: 'gain',
      ready: gainState.ready,
      failed: gainState.failed,
      state: gainState.ctx ? gainState.ctx.state : 'none',
    });
  }

  function buildChain(ctx, input, output) {
    const gain = ctx.createGain();
    gain.gain.value = 1;
    input.connect(gain);
    if (output) gain.connect(output);
    const bleepGain = ctx.createGain();
    bleepGain.gain.value = 0;
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 1000;
    oscillator.connect(bleepGain);
    bleepGain.connect(ctx.destination);
    oscillator.start();
    return { gain, bleepGain, oscillator };
  }

  // Intercept YouTube's own Web Audio use of the video element.
  try {
    const Base = window.BaseAudioContext || window.AudioContext;
    const original = Base && Base.prototype.createMediaElementSource;
    if (original && !Base.prototype.__cleanvidHooked) {
      Base.prototype.__cleanvidHooked = true;
      Base.prototype.createMediaElementSource = function cleanvidCreateSource(element) {
        const ours = elementSources.get(element);
        if (ours && ours.ctx !== this) {
          // We already own this element; give the page a silent stand-in so
          // its code keeps working while audio flows through our graph.
          return this.createGain();
        }
        const source = original.apply(this, arguments);
        if (element && element.tagName === 'VIDEO' && !ours) {
          try {
            const chain = buildChain(this, source, null);
            const originalConnect = source.connect.bind(source);
            const originalDisconnect = source.disconnect.bind(source);
            source.connect = (...args) => chain.gain.connect(...args);
            source.disconnect = (...args) => {
              try {
                return chain.gain.disconnect(...args);
              } catch {
                return originalDisconnect(...args);
              }
            };
            void originalConnect;
            elementSources.set(element, { ctx: this, ...chain, page: true });
          } catch {
            /* leave YouTube's graph untouched */
          }
        }
        return source;
      };
    }
  } catch {
    /* ignore */
  }

  function mainVideo() {
    return (
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  }

  function attachGain() {
    const video = mainVideo();
    if (!video) return false;
    if (gainState.video === video && gainState.ready) return true;
    const existing = elementSources.get(video);
    if (existing) {
      Object.assign(gainState, {
        ctx: existing.ctx,
        gain: existing.gain,
        bleepGain: existing.bleepGain,
        oscillator: existing.oscillator,
        video,
        ready: existing.ctx.state === 'running',
        failed: '',
      });
      bindMediaEvents(video);
      return gainState.ready;
    }
    // Create our own graph only once a running AudioContext is possible —
    // routing the element into a suspended context would silence the video.
    let ctx = gainState.ctx && !gainState.ownsSource ? null : gainState.ctx;
    try {
      if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch (error) {
      gainState.failed = 'no-webaudio';
      return false;
    }
    gainState.ctx = ctx;
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      return false;
    }
    try {
      const source = ctx.createMediaElementSource(video);
      const chain = buildChain(ctx, source, ctx.destination);
      elementSources.set(video, { ctx, ...chain, page: false });
      Object.assign(gainState, { ...chain, video, ownsSource: true, ready: true, failed: '' });
      bindMediaEvents(video);
      return true;
    } catch (error) {
      gainState.failed = 'source-failed';
      return false;
    }
  }

  function onUserGesture() {
    if (!gainState.active || gainState.ready) return;
    if (gainState.ctx && gainState.ctx.state !== 'running') {
      gainState.ctx.resume().then(() => {
        attachGain();
        reportGain();
        schedule(true);
      }).catch(() => {});
    } else {
      attachGain();
      reportGain();
    }
  }
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(type, onUserGesture, { capture: true, passive: true });
  }

  function levelAt(time) {
    for (const interval of gainState.intervals) {
      if (time < interval.start) return 1;
      if (time <= interval.end) return 0;
    }
    return 1;
  }

  /** Re-plan the next LOOKAHEAD seconds of gain automation. */
  function schedule(force = false) {
    if (!gainState.ready || !gainState.gain) return;
    const video = gainState.video;
    const ctx = gainState.ctx;
    if (!video || !video.isConnected || video !== mainVideo()) {
      gainState.ready = false;
      reportGain();
      return;
    }
    const param = gainState.gain.gain;
    const bleep = gainState.bleepGain.gain;
    const now = ctx.currentTime;
    const playing = !video.paused && !video.seeking && video.readyState >= 2;
    const rate = video.playbackRate || 1;
    const t = video.currentTime;
    const enabled = gainState.active && !adShowing();

    const events = [];
    const current = enabled ? levelAt(t) : 1;
    if (enabled && playing) {
      for (const interval of gainState.intervals) {
        if (interval.end < t) continue;
        if (interval.start > t + LOOKAHEAD * rate) break;
        if (interval.start > t) events.push({ at: now + (interval.start - t) / rate, level: 0 });
        if (interval.end > t && interval.end <= t + LOOKAHEAD * rate) {
          events.push({ at: now + (interval.end - t) / rate, level: 1 });
        }
      }
    }
    // Re-plan when the wanted level or the boundary set changes, or when the
    // media clock drifts more than ~10 ms from the plan.
    const key = `${current}|${events.map((e) => `${e.level}@${Math.round(e.at * 100)}`).join(',')}`;
    if (!force && key === gainState.lastKey) return;
    gainState.lastKey = key;
    gainState.plans = (gainState.plans || 0) + 1;
    gainState.lastPlan = { t: Math.round(t * 1000) / 1000, current, events: events.length, playing, force };

    const bleepLevel = (level) => (gainState.style === 'bleep' && enabled ? (1 - level) * 0.12 : 0);
    try {
      // Replace the whole automation timeline: hold the value that is
      // audible right now, fade to the level wanted now, then plan the
      // boundaries inside the look-ahead window. (cancelScheduledValues(now)
      // alone would leave an already-started curve running.)
      const heldGain = param.value;
      const heldBleep = bleep.value;
      param.cancelScheduledValues(0);
      bleep.cancelScheduledValues(0);
      param.setValueAtTime(heldGain, now);
      bleep.setValueAtTime(heldBleep, now);
      param.linearRampToValueAtTime(current, now + FADE);
      bleep.linearRampToValueAtTime(bleepLevel(current), now + FADE);
      let level = current;
      for (const event of events) {
        if (event.level === level) continue;
        // Mute fades complete by the word start; unmute fades start at its end.
        const earliest = now + FADE; // keep events after the initial ramp
        const from = Math.max(earliest, event.level === 0 ? event.at - FADE : event.at);
        const to = Math.max(from + 0.002, event.level === 0 ? event.at : event.at + FADE);
        param.setValueAtTime(level, from);
        param.linearRampToValueAtTime(event.level, to);
        bleep.setValueAtTime(bleepLevel(level), from);
        bleep.linearRampToValueAtTime(bleepLevel(event.level), to);
        level = event.level;
      }
    } catch {
      /* ignore scheduling races */
    }
  }

  const MEDIA_EVENTS = ['seeking', 'seeked', 'pause', 'play', 'playing', 'ratechange', 'waiting', 'timeupdate'];
  const boundVideos = new WeakSet();

  function onMediaEvent(event) {
    if (event.target !== gainState.video) return;
    if (event.type === 'timeupdate') {
      schedule(false);
      return;
    }
    gainState.lastKey = '';
    schedule(true);
  }

  function bindMediaEvents(video) {
    if (!video || boundVideos.has(video)) return;
    boundVideos.add(video);
    for (const type of MEDIA_EVENTS) video.addEventListener(type, onMediaEvent);
  }

  function startScheduler() {
    bindMediaEvents(gainState.video);
    if (gainState.timer) return;
    gainState.timer = setInterval(() => schedule(false), 40);
  }

  // Read-only diagnostics (DevTools console: __cleanvidGain()).
  window.__cleanvidGain = () => ({
    ready: gainState.ready,
    failed: gainState.failed,
    context: gainState.ctx ? gainState.ctx.state : 'none',
    level: gainState.gain ? gainState.gain.gain.value : null,
    clock: gainState.ctx ? gainState.ctx.currentTime : null,
    outputLatency: gainState.ctx ? gainState.ctx.outputLatency || 0 : null,
    intervals: gainState.intervals.length,
    active: gainState.active,
    style: gainState.style,
    plans: gainState.plans || 0,
    lastPlan: gainState.lastPlan || null,
    hidden: document.hidden,
  });

  function setIntervals(payload) {
    gainState.intervals = (Array.isArray(payload.intervals) ? payload.intervals : [])
      .filter((i) => i && Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
      .map((i) => ({ start: i.start, end: i.end }))
      .sort((a, b) => a.start - b.start);
    gainState.active = Boolean(payload.active);
    gainState.style = payload.style === 'bleep' ? 'bleep' : 'silence';
    if (gainState.active && !gainState.ready) attachGain();
    startScheduler();
    bindMediaEvents(gainState.video);
    gainState.lastKey = '';
    schedule(true);
    reportGain();
  }

  // --- Messaging ------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONTENT_SOURCE) return;

    if (data.type === 'request') {
      const id = data.id;
      const action = data.action;
      const payload = data.payload || {};
      (async () => {
        let response;
        try {
          if (action === 'get-player') {
            response = { ok: true, data: sendPlayerData(true) };
          } else if (action === 'captions') {
            response = await requestCaptions(payload);
          } else {
            response = { ok: false, error: `Unknown bridge action: ${action}` };
          }
        } catch (error) {
          response = {
            ok: false,
            error: error && error.message ? error.message : 'Bridge request failed.',
          };
        }
        post({
          source: BRIDGE_SOURCE,
          type: 'response',
          id,
          ok: Boolean(response.ok),
          data: response.data || null,
          error: response.error || '',
        });
      })();
      return;
    }

    if (data.type === 'resend-player') sendPlayerData(true);
    if (data.type === 'audio-listen') {
      audio.enabled = data.enabled !== false;
      if (audio.enabled) startAudioListening();
      else {
        audio.listening = false;
        audio.replay = [];
        audio.replayBytes = 0;
      }
    }
    if (data.type === 'gain-intervals') setIntervals(data);
    if (data.type === 'prefetch-start') {
      const videoId = String(data.videoId || '');
      if (videoId && prefetch.videoId !== videoId) {
        runPrefetch(videoId).then((result) =>
          post({ source: BRIDGE_SOURCE, type: 'prefetch-result', videoId, ...result })
        );
      }
    }
    if (data.type === 'prefetch-stop') stopPrefetch();
  });

  for (const eventName of [
    'yt-navigate-finish',
    'yt-page-data-updated',
    'yt-player-updated',
    'loadedmetadata',
  ]) {
    document.addEventListener(eventName, () => {
      setTimeout(() => sendPlayerData(true), 60);
      setTimeout(() => sendPlayerData(true), 700);
    });
  }

  window.addEventListener('load', () => sendPlayerData(true));

  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(() => sendPlayerData(false), 1000);

  sendPlayerData(true);
})();
