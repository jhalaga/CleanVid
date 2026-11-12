const { constants, Matcher } = globalThis.CleanVid;

const els = {
  enabled: document.getElementById('enabled'),
  muteAudio: document.getElementById('muteAudio'),
  maskCaptions: document.getElementById('maskCaptions'),
  useTranscriptFallback: document.getElementById('useTranscriptFallback'),
  tryYouTubeTranslation: document.getElementById('tryYouTubeTranslation'),
  useOpenSubtitles: document.getElementById('useOpenSubtitles'),
  openSubtitlesKey: document.getElementById('openSubtitlesKey'),
  saveOpenSubtitlesKey: document.getElementById('saveOpenSubtitlesKey'),
  openSubtitlesKeyStatus: document.getElementById('openSubtitlesKeyStatus'),
  highlightCurrent: document.getElementById('highlightCurrent'),
  panelCollapsed: document.getElementById('panelCollapsed'),
  mutePadding: document.getElementById('mutePadding'),
  mutePaddingValue: document.getElementById('mutePaddingValue'),
  captionLanguage: document.getElementById('captionLanguage'),
  sensitivityList: document.getElementById('sensitivityList'),
  heroWords: document.getElementById('heroWords'),
  heroSensitivity: document.getElementById('heroSensitivity'),
  wordTotal: document.getElementById('wordTotal'),
  wordSearch: document.getElementById('wordSearch'),
  addForm: document.getElementById('addForm'),
  newWord: document.getElementById('newWord'),
  addDefaults: document.getElementById('addDefaults'),
  resetDefaults: document.getElementById('resetDefaults'),
  wordChips: document.getElementById('wordChips'),
  noWords: document.getElementById('noWords'),
  bulkWords: document.getElementById('bulkWords'),
  bulkSave: document.getElementById('bulkSave'),
  bulkHint: document.getElementById('bulkHint'),
  tester: document.getElementById('tester'),
  runTest: document.getElementById('runTest'),
  testSummary: document.getElementById('testSummary'),
  testPreview: document.getElementById('testPreview'),
  toast: document.getElementById('toast'),
  version: document.getElementById('version'),
  footerVersion: document.getElementById('footerVersion'),
};

let settings = { ...constants.DEFAULT_SETTINGS };
let words = [];
let filter = '';
let toastTimer = null;
const OPENSUBTITLES_ORIGINS = [
  'https://api.opensubtitles.com/*',
  'https://*.opensubtitles.com/*',
];

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

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('visible');
  }, 2400);
}

function sensitivityMeta(id) {
  return (
    constants.SENSITIVITIES.find((item) => item.id === id) ||
    constants.SENSITIVITIES[1]
  );
}

function renderSensitivityOptions() {
  els.sensitivityList.textContent = '';
  for (const item of constants.SENSITIVITIES) {
    const label = document.createElement('label');
    label.className = 'sensitivity';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'sensitivity';
    input.value = item.id;

    const radio = document.createElement('span');
    radio.className = 'sensitivity-radio';

    const body = document.createElement('span');
    body.className = 'sensitivity-body';
    const title = document.createElement('span');
    title.className = 'sensitivity-title';
    title.append(document.createTextNode(item.label));
    const tag = document.createElement('span');
    tag.className = 'sensitivity-tag';
    tag.textContent = item.short;
    title.append(tag);
    const desc = document.createElement('span');
    desc.className = 'sensitivity-desc';
    desc.textContent = item.description;
    body.append(title, desc);

    label.append(input, radio, body);
    els.sensitivityList.append(label);
  }

  els.sensitivityList.addEventListener('change', (event) => {
    const input = event.target;
    if (!input || input.name !== 'sensitivity' || !input.checked) return;
    saveSetting({ sensitivity: input.value });
  });
}

function renderLanguageOptions() {
  els.captionLanguage.textContent = '';
  for (const language of constants.CAPTION_LANGUAGES) {
    const option = document.createElement('option');
    option.value = language.id;
    option.textContent = language.label;
    els.captionLanguage.append(option);
  }
}

function setSettingsUI() {
  els.enabled.checked = Boolean(settings.enabled);
  els.muteAudio.checked = Boolean(settings.muteAudio);
  els.maskCaptions.checked = Boolean(settings.maskCaptions);
  els.useTranscriptFallback.checked = Boolean(settings.useTranscriptFallback);
  els.tryYouTubeTranslation.checked = Boolean(settings.tryYouTubeTranslation);
  els.useOpenSubtitles.checked = Boolean(settings.useOpenSubtitles);
  els.highlightCurrent.checked = Boolean(settings.highlightCurrent);
  els.panelCollapsed.checked = Boolean(settings.panelCollapsed);

  const padding = Math.max(0, Math.min(500, Number(settings.mutePaddingMs) || 0));
  els.mutePadding.value = String(padding);
  els.mutePaddingValue.textContent = `${padding} ms`;
  els.captionLanguage.value = settings.captionLanguage || 'auto';

  const sensitivity = sensitivityMeta(settings.sensitivity);
  for (const input of els.sensitivityList.querySelectorAll('input[name="sensitivity"]')) {
    input.checked = input.value === sensitivity.id;
  }
  els.heroSensitivity.textContent = `${sensitivity.label} matching`;
}

async function saveSetting(patch) {
  settings = { ...settings, ...patch };
  setSettingsUI();
  try {
    const saved = await constants.saveSettings(patch);
    settings = { ...constants.DEFAULT_SETTINGS, ...saved };
  } catch {
    /* ignore */
  }
  if ('sensitivity' in patch) {
    setSettingsUI();
    runTest();
  }
}

function updateWordCounts() {
  const label = `${words.length} ${constants.pluralize(words.length, 'word')}`;
  els.wordTotal.textContent = label;
  els.heroWords.textContent = `${label} tracked`;
  els.bulkHint.textContent = `${words.length} / ${constants.MAX_WORDS} entries`;
}

function renderChips() {
  els.wordChips.textContent = '';
  const term = filter.trim().toLowerCase();
  const list = term ? words.filter((word) => word.includes(term)) : words;

  for (const word of list) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(document.createTextNode(word));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.word = word;
    remove.title = `Remove “${word}”`;
    remove.setAttribute('aria-label', `Remove ${word}`);
    remove.textContent = '×';
    chip.append(remove);
    els.wordChips.append(chip);
  }

  if (list.length) {
    els.noWords.hidden = true;
  } else {
    els.noWords.hidden = false;
    els.noWords.textContent = words.length
      ? `No words match “${filter.trim()}”.`
      : 'Your list is empty. CleanVid will not flag anything until you add a word.';
  }
}

function updateWordsUI() {
  updateWordCounts();
  renderChips();
  els.bulkWords.value = words.join('\n');
  els.wordSearch.value = filter;
}

async function saveWords(next, message) {
  words = constants.uniqueWords(next);
  try {
    const data = await constants.saveWordData(words);
    words = data.words;
  } catch {
    /* keep local copy */
  }
  updateWordsUI();
  runTest();
  if (message) toast(message);
}

function runTest() {
  const text = els.tester.value || '';
  if (!text.trim()) {
    els.testSummary.textContent = '—';
    els.testPreview.innerHTML =
      '<span class="placeholder">Type or paste a caption line above.</span>';
    return;
  }

  let index;
  try {
    index = Matcher.buildIndex(words, settings.sensitivity);
  } catch {
    els.testSummary.textContent = '—';
    els.testPreview.textContent = 'Could not build the word index.';
    return;
  }

  const { matches } = index.analyze(text);
  els.testSummary.textContent =
    matches.length === 0
      ? 'Nothing flagged'
      : `${matches.length} ${constants.pluralize(matches.length, 'match', 'matches')}`;

  let html = '';
  let cursor = 0;
  for (const match of matches) {
    html += escapeHtml(text.slice(cursor, match.start));
    html += `<mark>${escapeHtml(text.slice(match.start, match.end))}</mark>`;
    cursor = match.end;
  }
  html += escapeHtml(text.slice(cursor));

  els.testPreview.innerHTML = matches.length
    ? html
    : `${html}<span class="placeholder"> Nothing matched.</span>`;

  if (matches.length) {
    const seen = new Set();
    const list = document.createElement('div');
    list.className = 'test-words';
    for (const match of matches) {
      if (seen.has(match.entry.raw)) continue;
      seen.add(match.entry.raw);
      const chip = document.createElement('span');
      chip.className = 'test-word';
      chip.textContent = match.entry.raw;
      list.append(chip);
    }
    els.testPreview.append(list);
  }
}

async function init() {
  try {
    settings = { ...constants.DEFAULT_SETTINGS, ...(await constants.getSettings()) };
  } catch {
    settings = { ...constants.DEFAULT_SETTINGS };
  }

  let wordData = { words: [...constants.DEFAULT_WORDS] };
  try {
    wordData = await constants.getWordData();
  } catch {
    /* use defaults */
  }
  words = wordData.words;

  els.openSubtitlesKey.value = await constants.getOpenSubtitlesKey();
  if (els.openSubtitlesKey.value) {
    els.openSubtitlesKeyStatus.textContent = 'API key saved in this browser.';
  }

  renderSensitivityOptions();
  renderLanguageOptions();
  setSettingsUI();
  updateWordsUI();

  try {
    const version = chrome.runtime.getManifest().version;
    els.version.textContent = `v${version}`;
    els.footerVersion.textContent = `v${version}`;
  } catch {
    /* ignore */
  }

  for (const [element, key] of [
    [els.enabled, 'enabled'],
    [els.muteAudio, 'muteAudio'],
    [els.maskCaptions, 'maskCaptions'],
    [els.useTranscriptFallback, 'useTranscriptFallback'],
    [els.tryYouTubeTranslation, 'tryYouTubeTranslation'],
    [els.highlightCurrent, 'highlightCurrent'],
    [els.panelCollapsed, 'panelCollapsed'],
  ]) {
    element.addEventListener('change', () => {
      saveSetting({ [key]: element.checked });
    });
  }

  els.useOpenSubtitles.addEventListener('change', () => {
    const enabled = els.useOpenSubtitles.checked;
    if (!enabled) {
      chrome.permissions
        .remove({ origins: OPENSUBTITLES_ORIGINS })
        .catch(() => {})
        .finally(() => saveSetting({ useOpenSubtitles: false }));
      return;
    }
    // Call request directly in the checkbox's user-gesture handler.
    chrome.permissions
      .request({ origins: OPENSUBTITLES_ORIGINS })
      .then((granted) => {
        if (!granted) {
          els.useOpenSubtitles.checked = false;
          toast('OpenSubtitles site access was not granted.');
          return;
        }
        saveSetting({ useOpenSubtitles: true });
      })
      .catch(() => {
        els.useOpenSubtitles.checked = false;
        toast('Could not request OpenSubtitles site access.');
      });
  });

  els.saveOpenSubtitlesKey.addEventListener('click', async () => {
    try {
      await constants.saveOpenSubtitlesKey(els.openSubtitlesKey.value);
      els.openSubtitlesKey.value = await constants.getOpenSubtitlesKey();
      els.openSubtitlesKeyStatus.textContent = els.openSubtitlesKey.value
        ? 'API key saved in this browser.'
        : 'Saved key cleared.';
      toast(els.openSubtitlesKey.value ? 'OpenSubtitles API key saved.' : 'OpenSubtitles API key cleared.');
    } catch {
      els.openSubtitlesKeyStatus.textContent = 'Could not save the key.';
      toast('Could not save the OpenSubtitles API key.');
    }
  });

  els.mutePadding.addEventListener('input', () => {
    els.mutePaddingValue.textContent = `${els.mutePadding.value} ms`;
  });
  els.mutePadding.addEventListener('change', () => {
    saveSetting({ mutePaddingMs: Number(els.mutePadding.value) });
  });

  els.captionLanguage.addEventListener('change', () => {
    saveSetting({ captionLanguage: els.captionLanguage.value });
  });

  els.wordSearch.addEventListener('input', () => {
    filter = els.wordSearch.value;
    renderChips();
  });

  els.addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = els.newWord.value;
    const word = constants.normalizeWordInput(raw);
    if (!word) {
      toast('Enter a word or phrase containing letters.');
      return;
    }
    if (words.includes(word)) {
      toast('That word is already in the list.');
      return;
    }
    if (words.length >= constants.MAX_WORDS) {
      toast(`The list is limited to ${constants.MAX_WORDS} entries.`);
      return;
    }
    saveWords([...words, word], `Added “${word}”.`);
    els.newWord.value = '';
    els.newWord.focus();
  });

  els.wordChips.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-word]');
    if (!button) return;
    const word = button.dataset.word;
    saveWords(
      words.filter((item) => item !== word),
      `Removed “${word}”.`
    );
  });

  els.addDefaults.addEventListener('click', () => {
    const before = words.length;
    const merged = constants.mergeWordLists(words, constants.DEFAULT_WORDS);
    if (merged.length === before) {
      toast('All default words are already in the list.');
      return;
    }
    saveWords(merged, `Added ${merged.length - before} default words.`);
  });

  els.resetDefaults.addEventListener('click', () => {
    const confirmed = window.confirm(
      'Replace your whole list with the default CleanVid word list?'
    );
    if (!confirmed) return;
    saveWords([...constants.DEFAULT_WORDS], 'Word list reset to defaults.');
  });

  els.bulkSave.addEventListener('click', () => {
    const parsed = constants.parseWordListInput(els.bulkWords.value);
    if (!parsed.length && !window.confirm('Save an empty list? CleanVid will not flag anything.')) {
      return;
    }
    const merged = constants.uniqueWords(parsed);
    saveWords(merged, `Saved ${merged.length} words.`);
  });

  els.runTest.addEventListener('click', runTest);

  let testTimer = null;
  els.tester.addEventListener('input', () => {
    clearTimeout(testTimer);
    testTimer = setTimeout(runTest, 180);
  });

  runTest();
}

init();
