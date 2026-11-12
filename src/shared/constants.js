/**
 * CleanVid — shared constants and storage helpers.
 * Loaded as a classic script by the content script, options page and
 * service worker, so it exposes a single global namespace instead of modules.
 */
(() => {
  const NS = (globalThis.CleanVid = globalThis.CleanVid || {});
  if (NS.constants) return;

  const STORAGE_KEYS = Object.freeze({
    settings: 'cleanvid.settings',
    words: 'cleanvid.words',
    openSubtitlesKey: 'cleanvid.openSubtitlesKey',
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    muteAudio: true,
    maskCaptions: true,
    sensitivity: 'smart', // strict | smart | aggressive
    mutePaddingMs: 180,
    captionLanguage: 'auto',
    useTranscriptFallback: true,
    tryYouTubeTranslation: true,
    useOpenSubtitles: false,
    panelCollapsed: false,
    highlightCurrent: true,
    // On-device audio detection (2.0)
    audioEnabled: true,
    modelPack: 'standard', // standard | accurate
    audioPaddingMs: 70,
    muteStyle: 'silence', // silence | bleep
    pauseOnUnscanned: false,
    audioPrefetch: true,
  });

  /**
   * Speech models. Revisions are pinned to exact Hugging Face commits so a
   * model update upstream can never change what runs here unnoticed.
   * Sizes are approximate download sizes in MB per backend.
   */
  const MODEL_PACKS = Object.freeze({
    standard: Object.freeze({
      id: 'standard',
      label: 'Standard',
      short: 'Recommended',
      description: 'Whisper base (English) + wav2vec2 aligner. Fast on most computers.',
      whisper: { model: 'onnx-community/whisper-base.en', revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe' },
      sizeMb: { webgpu: 300, wasm: 175 },
    }),
    accurate: Object.freeze({
      id: 'accurate',
      label: 'High accuracy',
      short: 'Bigger & slower',
      description: 'Whisper small (English) + wav2vec2 aligner. Better on noisy or fast speech; needs a decent GPU.',
      whisper: { model: 'onnx-community/whisper-small.en', revision: '482fb8ba081b6e906f92efe103622316b2a0cc69' },
      sizeMb: { webgpu: 680, wasm: 345 },
    }),
  });

  const ALIGNER_MODEL = Object.freeze({
    model: 'Xenova/wav2vec2-base-960h',
    revision: 'a19f851b3d42865797e410752b4c570c871e4825',
  });

  // Bump when the analysis pipeline changes in a way that invalidates cached
  // transcripts.
  const PIPELINE_VERSION = 1;

  // Curated, editable seed list. Matching is whole-token, so "ass" does not
  // match "class" or "assume". Users can remove anything they consider fine.
  const DEFAULT_WORDS = Object.freeze([
    'apeshit',
    'arse',
    'arsehole',
    'ass',
    'asses',
    'asshat',
    'asshole',
    'assholes',
    'batshit',
    'bastard',
    'bastards',
    'bitch',
    'bitchass',
    'bitches',
    'bitchy',
    'bollocks',
    'bugger',
    'bullshit',
    'bullshitting',
    'chink',
    'clusterfuck',
    'cock',
    'cocks',
    'cocksucker',
    'crap',
    'crappy',
    'cum',
    'cumming',
    'cunt',
    'cunts',
    'damn',
    'damned',
    'dammit',
    'dick',
    'dickhead',
    'dickheads',
    'dicks',
    'dipshit',
    'douche',
    'douchebag',
    'douchebags',
    'dumbass',
    'dumbasses',
    'dyke',
    'fag',
    'faggot',
    'faggots',
    'fags',
    'fart',
    'farted',
    'farting',
    'farts',
    'fuck',
    'fuckboy',
    'fucked',
    'fucker',
    'fuckers',
    'fuckery',
    'fuckface',
    'fuckin',
    'fucking',
    'fucks',
    'fucktard',
    'fuckwit',
    'goddamn',
    'goddammit',
    'hell',
    'horseshit',
    'jackass',
    'jackasses',
    'jap',
    'jizz',
    'kike',
    'motherfucker',
    'motherfuckers',
    'motherfucking',
    'nigga',
    'niggas',
    'nigger',
    'niggers',
    'piss',
    'pissed',
    'pisses',
    'pissing',
    'prick',
    'pricks',
    'pussy',
    'pussies',
    'retard',
    'retarded',
    'retards',
    'shit',
    'shitbag',
    'shithead',
    'shitheads',
    'shits',
    'shitstain',
    'shitstorm',
    'shitting',
    'shitty',
    'slut',
    'sluts',
    'slutty',
    'spic',
    'tit',
    'tits',
    'titties',
    'tranny',
    'twat',
    'twats',
    'wank',
    'wanked',
    'wanker',
    'wankers',
    'wanking',
    'wanks',
    'wetback',
    'whore',
    'whores',
  ]);

  const SENSITIVITIES = Object.freeze([
    {
      id: 'strict',
      label: 'Strict',
      short: 'Exact matches only',
      description:
        'Only exact, normalized matches. Catches profanity, leetspeak and censored spellings with no spelling tolerance.',
    },
    {
      id: 'smart',
      label: 'Smart',
      short: 'Recommended',
      description:
        'Exact matches plus cautious typo tolerance for longer words. Designed to catch real profanity without muting innocent look-alikes.',
    },
    {
      id: 'aggressive',
      label: 'Aggressive',
      short: 'Catches more',
      description:
        'Looser spelling tolerance for shorter words. Catches creative misspellings but may flag an occasional innocent word.',
    },
  ]);

  const CAPTION_LANGUAGES = Object.freeze([
    { id: 'auto', label: 'Auto (recommended)' },
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Spanish' },
    { id: 'fr', label: 'French' },
    { id: 'de', label: 'German' },
    { id: 'pt', label: 'Portuguese' },
    { id: 'it', label: 'Italian' },
    { id: 'nl', label: 'Dutch' },
    { id: 'pl', label: 'Polish' },
    { id: 'ru', label: 'Russian' },
    { id: 'uk', label: 'Ukrainian' },
    { id: 'tr', label: 'Turkish' },
    { id: 'ar', label: 'Arabic' },
    { id: 'hi', label: 'Hindi' },
    { id: 'ja', label: 'Japanese' },
    { id: 'ko', label: 'Korean' },
    { id: 'zh', label: 'Chinese' },
  ]);

  const MAX_WORDS = 1000;
  const MAX_WORD_LENGTH = 64;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const normalizeWhitespace = (value) =>
    String(value || '').replace(/\s+/g, ' ').trim();

  /** Normalize a word list entry for storage/display. Returns '' when invalid. */
  function normalizeWordInput(input) {
    if (typeof input !== 'string') return '';
    let value = input
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    value = value.replace(/^[^\p{L}\p{N}*#•·]+|[^\p{L}\p{N}*#•·]+$/gu, '');
    if (!value || value.length > MAX_WORD_LENGTH) return '';
    if (!/[\p{L}]/u.test(value)) return '';
    if (!/^[\p{L}\p{N}*#•·'\- ]+$/u.test(value)) return '';
    // "f u c k" typed as individual letters is folded into one token.
    const parts = value.split(' ');
    if (parts.length >= 3 && parts.every((part) => part.length === 1)) {
      value = parts.join('');
    }
    return normalizeWhitespace(value);
  }

  function parseWordListInput(input) {
    // Supports newlines, commas and semicolons while keeping phrases intact.
    return String(input || '')
      .split(/[\n,;]+/)
      .map(normalizeWordInput)
      .filter(Boolean);
  }

  function mergeWordLists(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const word = normalizeWordInput(item);
        if (!word || seen.has(word)) continue;
        seen.add(word);
        out.push(word);
        if (out.length >= MAX_WORDS) return out;
      }
    }
    return out;
  }

  function uniqueWords(words) {
    return mergeWordLists(words);
  }

  function formatTime(totalSeconds, { forceHours = false } = {}) {
    const seconds = Number(totalSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    if (h > 0 || forceHours) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function pluralize(count, singular, plural = `${singular}s`) {
    return count === 1 ? singular : plural;
  }

  function debounce(fn, wait = 200) {
    let timer = null;
    const debounced = (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, wait);
    };
    debounced.cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return debounced;
  }

  function clampProgress(value) {
    return clamp(Number(value) || 0, 0, 100);
  }

  async function getSettings() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
      const saved = stored[STORAGE_KEYS.settings] || {};
      const settings = { ...DEFAULT_SETTINGS, ...saved };
      // The old release defaulted translated-caption scanning off. Enable it
      // once on upgrade so the broader automatic caption scan is active, then
      // preserve any choice the user makes in this version.
      if (saved.captionSourceVersion !== 1) {
        settings.tryYouTubeTranslation = true;
        settings.captionSourceVersion = 1;
        await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
      }
      return settings;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  let settingsWriteQueue = Promise.resolve();
  function saveSettings(patch) {
    const write = async () => {
      const current = await getSettings();
      const next = { ...current, ...patch };
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
      return next;
    };
    const result = settingsWriteQueue.then(write, write);
    settingsWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function getWordData() {
    let stored = null;
    try {
      stored = await chrome.storage.local.get(STORAGE_KEYS.words);
    } catch {
      stored = null;
    }
    const raw = stored?.[STORAGE_KEYS.words];
    if (raw && Array.isArray(raw.words)) {
      return { version: 1, words: uniqueWords(raw.words) };
    }
    // First run (or storage was cleared): seed the default list.
    const seeded = { version: 1, words: [...DEFAULT_WORDS] };
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.words]: seeded });
    } catch {
      /* storage may be unavailable during teardown */
    }
    return seeded;
  }

  async function saveWordData(words) {
    const data = { version: 1, words: uniqueWords(words) };
    await chrome.storage.local.set({ [STORAGE_KEYS.words]: data });
    return data;
  }

  async function getOpenSubtitlesKey() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.openSubtitlesKey);
      return String(stored[STORAGE_KEYS.openSubtitlesKey] || '').trim();
    } catch {
      return '';
    }
  }

  async function saveOpenSubtitlesKey(value) {
    const key = String(value || '').trim();
    await chrome.storage.local.set({ [STORAGE_KEYS.openSubtitlesKey]: key });
    return key;
  }

  async function ensureStorage() {
    const settings = await getSettings();
    const words = await getWordData();
    return { settings, words };
  }

  function isWatchPage(url = location.href) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'www.youtube.com' && parsed.hostname !== 'youtube.com') {
        return false;
      }
      return parsed.pathname === '/watch' && Boolean(parsed.searchParams.get('v'));
    } catch {
      return false;
    }
  }

  function getVideoIdFromUrl(url = location.href) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || null;
      const live = parsed.pathname.match(/^\/live\/([\w-]+)/);
      if (live) return live[1];
      return null;
    } catch {
      return null;
    }
  }

  NS.constants = {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    DEFAULT_WORDS,
    SENSITIVITIES,
    CAPTION_LANGUAGES,
    MODEL_PACKS,
    ALIGNER_MODEL,
    PIPELINE_VERSION,
    MAX_WORDS,
    MAX_WORD_LENGTH,
    clamp,
    clampProgress,
    normalizeWhitespace,
    normalizeWordInput,
    parseWordListInput,
    mergeWordLists,
    uniqueWords,
    formatTime,
    pluralize,
    debounce,
    getSettings,
    saveSettings,
    getWordData,
    saveWordData,
    getOpenSubtitlesKey,
    saveOpenSubtitlesKey,
    ensureStorage,
    isWatchPage,
    getVideoIdFromUrl,
  };
})();
