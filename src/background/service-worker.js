/**
 * CleanVid — service worker.
 * Keeps the toolbar badge in sync and opens the options page on request.
 */
importScripts('/src/shared/constants.js');

const BADGE_COLORS = {
  hits: '#ff5f78',
  clean: '#2ad4a4',
  busy: '#1f3b4d',
  warning: '#ffc861',
  idle: '#3a4a5a',
};

function quiet(value) {
  if (value && typeof value.catch === 'function') value.catch(() => {});
}

function setBadge(tabId, text, background, foreground) {
  if (tabId == null || tabId < 0) return;
  quiet(chrome.action.setBadgeText({ tabId, text }));
  try {
    quiet(chrome.action.setBadgeBackgroundColor({ tabId, color: background }));
    if (chrome.action.setBadgeTextColor) {
      quiet(chrome.action.setBadgeTextColor({ tabId, color: foreground }));
    }
  } catch {
    /* older Chrome */
  }
}

function normalizedTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(official|video|music|4k|hd|remastered|remaster|youtube)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 2);
}

function titleSimilarity(left, right) {
  const a = new Set(normalizedTitle(left));
  const b = new Set(normalizedTitle(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.max(a.size, b.size);
}

async function fetchOpenSubtitles(title, apiKey) {
  const apiHeaders = {
    Accept: 'application/json',
    'Api-Key': apiKey,
    'X-User-Agent': 'CleanVid v1.3.0',
  };
  const searchUrl = new URL('https://api.opensubtitles.com/api/v1/subtitles');
  searchUrl.searchParams.set('languages', 'en');
  searchUrl.searchParams.set('query', title.toLowerCase());

  const searchResponse = await fetch(searchUrl, { headers: apiHeaders });
  if (!searchResponse.ok) {
    throw new Error(
      searchResponse.status === 401 || searchResponse.status === 403
        ? 'OpenSubtitles rejected the API key. Check the key in settings.'
        : `OpenSubtitles search failed (HTTP ${searchResponse.status}).`
    );
  }
  const searchData = await searchResponse.json();
  const candidates = Array.isArray(searchData.data) ? searchData.data : [];
  const candidate = candidates
    .map((item) => {
      const feature = item && item.attributes && item.attributes.feature_details;
      const candidateTitle = feature && (feature.title || feature.movie_name);
      return {
        item,
        candidateTitle: candidateTitle || '',
        score: titleSimilarity(title, candidateTitle),
      };
    })
    .filter(({ item, score }) => {
      const attrs = item && item.attributes;
      return attrs && String(attrs.language || '').toLowerCase().startsWith('en') && score >= 0.45;
    })
    .sort((a, b) => b.score - a.score)[0];

  const file = candidate && candidate.item.attributes.files && candidate.item.attributes.files[0];
  if (!file || !file.file_id) {
    return { ok: false, error: 'No close English OpenSubtitles match was found.' };
  }

  const downloadResponse = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: {
      ...apiHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file_id: file.file_id, sub_format: 'srt' }),
  });
  if (!downloadResponse.ok) {
    throw new Error(
      downloadResponse.status === 401 || downloadResponse.status === 403
        ? 'OpenSubtitles requires an available download quota or account authorization.'
        : `OpenSubtitles download link failed (HTTP ${downloadResponse.status}).`
    );
  }
  const downloadData = await downloadResponse.json();
  let downloadUrl;
  try {
    downloadUrl = new URL(downloadData.link);
  } catch {
    throw new Error('OpenSubtitles returned an invalid download link.');
  }
  if (
    downloadUrl.protocol !== 'https:' ||
    !(downloadUrl.hostname === 'opensubtitles.com' || downloadUrl.hostname.endsWith('.opensubtitles.com'))
  ) {
    throw new Error('OpenSubtitles returned a download link outside its service domain.');
  }

  const subtitleResponse = await fetch(downloadUrl.href, {
    headers: { 'X-User-Agent': 'CleanVid v1.3.0' },
  });
  if (!subtitleResponse.ok) {
    throw new Error(`OpenSubtitles subtitle download failed (HTTP ${subtitleResponse.status}).`);
  }
  const text = await subtitleResponse.text();
  if (!text || text.length > 2_000_000) {
    throw new Error('OpenSubtitles returned an empty or oversized subtitle file.');
  }
  return {
    ok: true,
    text,
    title: candidate.candidateTitle,
    provider: 'OpenSubtitles',
  };
}

// --- Offscreen audio engine ---------------------------------------------------

const ENGINE_URL = 'src/engine/engine.html';
let enginePromise = null;
let engineReadyResolve = null;

async function engineExists() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(ENGINE_URL)],
      });
      return contexts.length > 0;
    }
  } catch {
    /* fall through */
  }
  return false;
}

function ensureEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (await engineExists()) return true;
    const ready = new Promise((resolve) => {
      engineReadyResolve = resolve;
      setTimeout(resolve, 4000);
    });
    try {
      await chrome.offscreen.createDocument({
        url: ENGINE_URL,
        reasons: ['WORKERS'],
        justification: 'Runs the on-device speech recognition models that find profanity in video audio.',
      });
    } catch (error) {
      // "Only a single offscreen document may be created" — already there.
      if (!/single offscreen/i.test(String(error && error.message))) throw error;
    }
    await ready;
    return true;
  })().finally(() => {
    setTimeout(() => {
      enginePromise = null;
    }, 0);
  });
  return enginePromise;
}

async function closeEngine() {
  try {
    if (await engineExists()) await chrome.offscreen.closeDocument();
  } catch {
    /* ignore */
  }
}

// Both entry points control the same in-page panel.
async function onToolbarClicked(tab) {
  if (tab.id != null) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
      if (result?.ok) return;
    } catch {
      /* No content script on this tab (or it needs a reload after an update). */
    }
  }
  await chrome.runtime.openOptionsPage();
}

chrome.action.onClicked.addListener(onToolbarClicked);

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await CleanVid.constants.ensureStorage();
  } catch {
    /* storage may be unavailable */
  }
  const previousMajor = Number(String((details && details.previousVersion) || '0').split('.')[0]) || 0;
  // First install, or an upgrade from the caption-only 1.x: explain the
  // on-device models and offer the download.
  if (details && (details.reason === 'install' || (details.reason === 'update' && previousMajor < 2))) {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
    } catch {
      /* ignore */
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'engine-ensure') {
    ensureEngine()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || 'Engine failed to start.' }));
    return true;
  }

  if (message.type === 'engine-ready') {
    if (engineReadyResolve) engineReadyResolve();
    engineReadyResolve = null;
    return;
  }

  if (message.type === 'engine-idle') {
    closeEngine();
    return;
  }

  if (message.type === 'open-onboarding') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'lookup-opensubtitles') {
    const url = sender && sender.tab && sender.tab.url;
    const title = String(message.title || '').trim().slice(0, 240);
    const apiKey = String(message.apiKey || '').trim();
    if (!/^https:\/\/(www\.)?youtube\.com\/watch\b/i.test(String(url || ''))) {
      sendResponse({ ok: false, error: 'OpenSubtitles lookup is only available on a YouTube watch page.' });
      return;
    }
    if (!title || !apiKey) {
      sendResponse({ ok: false, error: 'Add an OpenSubtitles API key to use this fallback.' });
      return;
    }
    fetchOpenSubtitles(title, apiKey)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || 'OpenSubtitles lookup failed.' }));
    return true;
  }

  if (message.type === 'set-badge') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const status = message.status;
    const count = Math.max(0, Number(message.count) || 0);

    if (status === 'ready') {
      if (count > 0) {
        setBadge(
          tabId,
          count > 99 ? '99+' : String(count),
          BADGE_COLORS.hits,
          '#25060b'
        );
      } else {
        setBadge(tabId, '✓', BADGE_COLORS.clean, '#042018');
      }
    } else if (status === 'loading' || status === 'analyzing' || status === 'waiting') {
      setBadge(tabId, '…', BADGE_COLORS.busy, '#9de9ff');
    } else if (status === 'empty' || status === 'error') {
      setBadge(tabId, '!', BADGE_COLORS.warning, '#2a1d00');
    } else {
      setBadge(tabId, '', BADGE_COLORS.idle, '#ffffff');
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'get-version') {
    sendResponse({ version: chrome.runtime.getManifest().version });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    try {
      const result = chrome.action.setBadgeText({ tabId, text: '' });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* ignore */
    }
  }
});
