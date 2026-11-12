/**
 * End-to-end smoke test with a mocked YouTube timedtext response.
 *
 * Loads the unpacked extension in headless Chrome, opens a YouTube watch page,
 * fulfills every timedtext request with a JSON3 fixture, then verifies:
 *   - the content script and shadow-DOM panel are injected,
 *   - captions are parsed and analyzed,
 *   - mute intervals engage and release,
 *   - caption masking rewrites a caption node,
 *   - options page renders without extension errors.
 *
 * Usage: node tools/e2e-smoke.mjs [videoId]
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;
const videoId = process.argv[2] || 'dQw4w9WgXcQ';
const userDataDir = path.join(os.tmpdir(), `cleanvid-e2e-${Date.now()}`);
const outDir = path.join(ROOT, 'tools', 'fixtures');
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

if (!fs.existsSync(CHROME)) {
  console.error(
    `Chrome was not found at ${CHROME}.\nSet CHROME_PATH to a Chrome or Edge executable and retry.`
  );
  process.exit(1);
}

const FIXTURE = JSON.stringify({
  events: [
    {
      tStartMs: 4000,
      dDurationMs: 3000,
      segs: [
        { utf8: 'This is a ' },
        { utf8: 'fucking ', tOffsetMs: 800 },
        { utf8: 'test.', tOffsetMs: 1700 },
      ],
    },
    {
      tStartMs: 11000,
      dDurationMs: 3000,
      segs: [
        { utf8: 'What the ' },
        { utf8: 'shit', tOffsetMs: 900 },
        { utf8: ' is this?', tOffsetMs: 1700 },
      ],
    },
    {
      tStartMs: 18000,
      dDurationMs: 3000,
      segs: [{ utf8: 'passes context is a perfectly clean sentence.' }],
    },
    {
      tStartMs: 25000,
      dDurationMs: 8000,
      segs: [
        { utf8: 'Damn, ' },
        { utf8: 'low angle, this PewDiePie feels like a perfectly clean sentence.', tOffsetMs: 0 },
      ],
    },
    {
      tStartMs: 38000,
      dDurationMs: 2500,
      segs: [
        { utf8: 'That was ' },
        { utf8: 'fucked-up', tOffsetMs: 500 },
        { utf8: '.', tOffsetMs: 900 },
      ],
    },
  ],
});
const TRANSLATED_FIXTURE = JSON.stringify({
  events: [
    ...JSON.parse(FIXTURE).events,
    {
      tStartMs: 44000,
      dDurationMs: 3000,
      segs: [
        { utf8: 'That thing is a ' },
        { utf8: 'fucking', tOffsetMs: 1000 },
        { utf8: ' brilliant tool.', tOffsetMs: 1600 },
      ],
    },
  ],
});

const issues = [];
const notes = [];
const errors = [];
const translatedRequests = [];

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-extension-debugging',
    '--window-size=1280,800',
    '--lang=en-US',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

chrome.stderr.on('data', (data) => {
  const text = String(data);
  if (/CleanVid|Uncaught|content script/i.test(text)) errors.push(text.trim());
});

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const handler of this.handlers.get(message.method) || []) handler(message.params);
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return response.json();
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint did not start.');
}

function extensionIdFromPath(value) {
  const hash = crypto.createHash('sha256').update(value).digest();
  let id = '';
  for (const byte of hash.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

let page;
let cdp;
let browserCdp;
let fetchPaused = 0;
let loadedExtensionId = '';

try {
  const version = await waitForDevtools();
  notes.push(`browser ${version.Browser}`);

  browserCdp = new CDP(version.webSocketDebuggerUrl);
  await browserCdp.ready;
  try {
    const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: ROOT });
    loadedExtensionId = loaded.id;
    notes.push(`loaded extension id: ${loadedExtensionId}`);
  } catch (error) {
    notes.push(`Extensions.loadUnpacked failed: ${error.message}`);
  }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('No page target found.');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/timedtext*', requestStage: 'Request' }],
  });

  cdp.on('Fetch.requestPaused', (params) => {
    fetchPaused += 1;
    const translated = new URL(params.request.url).searchParams.get('tlang') === 'en';
    if (translated) {
      translatedRequests.push(params.request.url);
    }
    const body = Buffer.from(translated ? TRANSLATED_FIXTURE : FIXTURE, 'utf8').toString('base64');
    cdp
      .send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body,
      })
      .catch((error) => issues.push(`fulfill failed: ${error.message}`));
  });

  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    const description = details.exception?.description || details.text || 'unknown';
    const url = details.url || '';
    const stack = details.stackTrace?.callFrames?.map((frame) => frame.url).join(' ') || '';
    if (/chrome-extension:\/\//.test(url) || /chrome-extension:\/\//.test(stack) || /cleanvid/i.test(description)) {
      issues.push(`exception: ${description.slice(0, 500)}`);
    }
  });

  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    if (entry.level === 'error' && /chrome-extension:\/\//.test(entry.url || '')) {
      issues.push(`console error (${entry.url}): ${entry.text}`);
    }
  });

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'Evaluation failed'
      );
    }
    return result.result.value;
  };

  await cdp.send('Page.navigate', { url: `https://www.youtube.com/watch?v=${videoId}` });
  // First install opens the onboarding tab; keep the tested page in front so
  // media loads and timers are not background-throttled.
  await cdp.send('Page.bringToFront');

  const panelExpression = `(() => {
    const host = document.getElementById('cleanvid-root');
    if (!host) return null;
    const root = host.shadowRoot;
    if (!root) return { host: true, shadow: false };
    const text = root.querySelector('.cv-panel')?.innerText || '';
    return {
      host: true,
      shadow: true,
      hidden: host.hidden,
      status: host.dataset.status || '',
      muting: host.dataset.muting || '',
      count: root.querySelector('.cv-count')?.textContent || '',
      stage: root.querySelector('[data-ref="stage"]')?.textContent || '',
      emptyDisplay: root.querySelector('.cv-empty')
        ? getComputedStyle(root.querySelector('.cv-empty')).display
        : '',
      rows: [...root.querySelectorAll('.cv-row')].slice(0, 6).map((row) => ({
        time: row.querySelector('.cv-row-time')?.textContent || '',
        word: row.querySelector('.cv-row-word')?.textContent || '',
        seek: Number(row.dataset.seek || 0),
      })),
      hasManualTimestampControl: !!root.querySelector('[data-action="add-mute"]'),
      text: text.slice(0, 800),
    };
  })()`;

  let panel = null;
  for (let i = 0; i < 60; i++) {
    panel = await evaluate(panelExpression);
    if (panel && panel.shadow && ['ready', 'empty', 'error'].includes(panel.status)) break;
    await sleep(500);
  }
  try {
    const pageInfo = await evaluate(`({
      url: location.href,
      title: document.title,
      ready: document.readyState,
      body: (document.body?.innerText || '').slice(0, 320),
      player: !!document.querySelector('#movie_player'),
      scripts: document.querySelectorAll('script').length
    })`);
    notes.push(`page: ${JSON.stringify(pageInfo)}`);
  } catch (error) {
    notes.push(`page info failed: ${error.message}`);
  }
  try {
    const discovered = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    notes.push(
      `targets: ${discovered
        .map((target) => `${target.type}:${String(target.url || '').slice(0, 90)}`)
        .join(' | ')}`
    );
  } catch {
    /* ignore */
  }
  assert.ok(panel && panel.host && panel.shadow, 'CleanVid panel was not injected into the page.');
  assert.equal(panel.hasManualTimestampControl, false, 'The manual timestamp workflow should not be present.');
  const interactions = await evaluate(`(() => {
    const host = document.getElementById('cleanvid-root');
    const root = host.shadowRoot;
    const fab = root.querySelector('.cv-fab');
    const list = root.querySelector('[data-ref="list"]');
    const toggle = root.querySelector('[data-ref="listToggle"]');
    const initialListHidden = list.hidden;
    toggle.click();
    const expanded = !list.hidden && toggle.getAttribute('aria-expanded') === 'true';
    toggle.click();
    const recollapsed = list.hidden && toggle.getAttribute('aria-expanded') === 'false';
    fab.click();
    const collapsed = host.classList.contains('cv-collapsed') && fab.getAttribute('aria-expanded') === 'false';
    fab.click();
    const reopened = !host.classList.contains('cv-collapsed') && fab.getAttribute('aria-expanded') === 'true';
    const fabVisible = getComputedStyle(fab).display !== 'none';
    const title = root.querySelector('[data-ref="title"]');
    title.textContent = 'A long YouTube video title that needs several lines to stay readable in this compact panel';
    const titleRect = title.getBoundingClientRect();
    const titleReadable = titleRect.height >= 30 && title.scrollHeight <= titleRect.height + 1;
    const panelRect = root.querySelector('.cv-panel').getBoundingClientRect();
    const fabRect = fab.getBoundingClientRect();
    return { initialListHidden, expanded, recollapsed, collapsed, reopened, fabVisible, titleReadable,
      noOverlap: panelRect.bottom < fabRect.top };
  })()`);
  for (const [check, passed] of Object.entries(interactions)) {
    assert.equal(passed, true, `Panel interaction failed: ${check}`);
  }
  notes.push('panel toggle, collapsed word list, readable title and persistent button verified');
  const workerTarget = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .find((target) => target.type === 'service_worker' && target.url.endsWith('/src/background/service-worker.js'));
  assert.ok(workerTarget, 'Extension service worker was not found.');
  const workerCdp = new CDP(workerTarget.webSocketDebuggerUrl);
  await workerCdp.ready;
  try {
    for (const expectedCollapsed of [true, false]) {
      const result = await workerCdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
          if (!tab) throw new Error('Test video tab not found');
          if (await chrome.action.getPopup({ tabId: tab.id })) throw new Error('Separate popup is still configured');
          await onToolbarClicked(tab);
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      assert.equal(result.exceptionDetails, undefined, 'Toolbar handler failed');
      assert.equal(await evaluate(`document.getElementById('cleanvid-root').classList.contains('cv-collapsed')`),
        expectedCollapsed, 'Toolbar did not toggle the shared panel');
    }
  } finally {
    workerCdp.close();
  }
  notes.push('toolbar handler opens and closes the same floating panel; no separate popup configured');

  notes.push(`panel status: ${panel.status || 'unknown'}`);
  notes.push(`panel rows: ${JSON.stringify(panel.rows)}`);
  notes.push(`timedtext requests mocked: ${fetchPaused}`);
  notes.push(`English translation requests: ${translatedRequests.length}`);

  if (panel.status !== 'ready') {
    issues.push(
      `panel did not reach ready (status=${panel.status || 'none'}): ${panel.text || 'no text'}`
    );
  } else {
    assert.ok(fetchPaused > 0, 'The bridge never requested timedtext.');
    assert.equal(panel.count, '5', `Expected 5 flagged moments, got ${panel.count}.`);
    assert.ok(translatedRequests.length > 0, 'YouTube English translations should be scanned by default.');
    assert.equal(panel.emptyDisplay, 'none', 'Empty state should be hidden when moments exist.');
    assert.equal(panel.rows.length >= 2, true, 'Expected at least two occurrence rows.');
    assert.match(panel.rows[0].word, /f\*+/, 'First row should be masked profanity.');
    assert.ok(panel.rows[0].seek >= 4 && panel.rows[0].seek < 6, 'First moment should be near 4.8s.');
    assert.ok(panel.rows.some((row) => row.time === '0:25' && row.word.startsWith('D')),
      'Damn should be detected near 25 seconds.');
    assert.ok(panel.rows.some((row) => row.seek >= 38 && row.seek < 39 && row.word.startsWith('f')),
      'The profanity in a hyphenated word should be detected at its own timestamp.');
    assert.ok(panel.rows.some((row) => row.seek >= 45 && row.seek < 46 && row.word.startsWith('f')),
      'A word omitted by the source captions should be detected from the translated track.');

    const muteCheck = await evaluate(`(async () => {
      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (!video) return { error: 'no video' };
      const ad = document.getElementById('movie_player')?.classList.contains('ad-showing');
      // Muted either through the Web Audio gain (sample-accurate path) or
      // through video.muted (fallback path).
      const isMuted = () => {
        const gain = window.__cleanvidGain ? window.__cleanvidGain() : null;
        if (gain && gain.ready) return gain.level < 0.05;
        return video.muted;
      };
      const gainInfo = window.__cleanvidGain ? window.__cleanvidGain() : null;
      const before = isMuted();
      video.pause();
      video.currentTime = 4.95;
      video.dispatchEvent(new Event('timeupdate'));
      // The Web Audio path may still be starting right after page load; give
      // the handover from the video.muted fallback a moment.
      let during = false;
      for (let i = 0; i < 10 && !during; i++) {
        await new Promise(r => setTimeout(r, 80));
        during = isMuted();
      }
      const duringCurrent = video.currentTime;
      video.currentTime = 20;
      await new Promise(r => setTimeout(r, 700));
      const after = isMuted();
      const afterGain = window.__cleanvidGain ? JSON.stringify({ ...window.__cleanvidGain(), t: video.currentTime, paused: video.paused, seeking: video.seeking, muted: video.muted }) : '';
      video.currentTime = 25.1;
      await new Promise(r => setTimeout(r, 500));
      const duringDamn = isMuted();
      const damnGain = window.__cleanvidGain ? JSON.stringify({ ...window.__cleanvidGain(), t: video.currentTime, paused: video.paused, seeking: video.seeking, muted: video.muted }) : '';
      video.currentTime = 27.5;
      await new Promise(r => setTimeout(r, 500));
      const afterDamn = isMuted();
      const afterHighlight = document.getElementById('cleanvid-root')?.shadowRoot
        ?.querySelectorAll('.cv-row.is-current').length ?? -1;
      const muting = document.getElementById('cleanvid-root')?.dataset.muting || '';
      return { ad, before, during, after, duringCurrent, duringDamn, afterDamn, afterHighlight, muting, path: gainInfo && gainInfo.ready ? 'webaudio' : 'video.muted', afterGain, damnGain };
    })()`);

    if (muteCheck.error) {
      issues.push(`mute check failed: ${muteCheck.error}`);
    } else if (muteCheck.ad) {
      notes.push('mute check skipped because an ad was showing');
      if (muteCheck.after) issues.push('video stayed muted after leaving the interval.');
    } else {
      notes.push(`mute detail: ${JSON.stringify(muteCheck)}`);
      notes.push(`mute states before/during/after: ${muteCheck.before}/${muteCheck.during}/${muteCheck.after}`);
      assert.equal(muteCheck.during, true, 'Audio should be muted at the first flagged moment.');
      assert.equal(muteCheck.after, false, 'Audio should unmute after the flagged moments.');
      assert.equal(muteCheck.duringDamn, true, 'Audio should mute at the Damn timestamp.');
      assert.equal(muteCheck.afterDamn, false, 'Mute should stop shortly after Damn, not cover the rest of the caption.');
      assert.equal(muteCheck.afterHighlight, 0, 'Stale timeline highlight should clear after seeking away.');
    }

    const maskResult = await evaluate(`(async () => {
      const el = document.createElement('div');
      el.className = 'ytp-caption-segment';
      el.textContent = 'fucking shit';
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 500));
      const masked = el.textContent;
      el.remove();
      return masked;
    })()`);
    notes.push(`caption mask result: ${JSON.stringify(maskResult)}`);
    assert.match(maskResult, /^\*+ \*+$/, 'Caption masking should replace profanity with asterisks.');
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'e2e-panel.png'), Buffer.from(shot.data, 'base64'));
    notes.push('wrote tools/fixtures/e2e-panel.png');
    const panelClip = await evaluate(`(() => {
      const root = document.getElementById('cleanvid-root').shadowRoot;
      const panel = root.querySelector('.cv-panel').getBoundingClientRect();
      const fab = root.querySelector('.cv-fab').getBoundingClientRect();
      return { x: panel.x - 8, y: panel.y - 8, width: panel.width + 16,
        height: fab.bottom - panel.y + 16, scale: 1 };
    })()`);
    const detail = await cdp.send('Page.captureScreenshot', { format: 'png', clip: panelClip });
    fs.writeFileSync(path.join(outDir, 'e2e-panel-detail.png'), Buffer.from(detail.data, 'base64'));
  } catch (error) {
    notes.push(`panel screenshot failed: ${error.message}`);
  }

  // Find the extension id and smoke the options page.
  let extensionId = loadedExtensionId;
  if (!extensionId) {
    try {
      if (!browserCdp) {
        browserCdp = new CDP(version.webSocketDebuggerUrl);
        await browserCdp.ready;
      }
      const discovered = await browserCdp.send('Target.getTargets');
      for (const target of discovered.targetInfos || []) {
        const match = String(target.url || '').match(/^chrome-extension:\/\/([a-p]{32})\//);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
    } catch (error) {
      notes.push(`target discovery failed: ${error.message}`);
    }
  }
  if (!extensionId) extensionId = extensionIdFromPath(ROOT);
  notes.push(`extension id: ${extensionId}`);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', {
    url: `chrome-extension://${extensionId}/src/options/options.html`,
  });
  await cdp.send('Page.bringToFront');
  await sleep(1800);
  await evaluate(`(() => {
    const tester = document.getElementById('tester');
    tester.value = 'Holy sh*t, that was d*mn amazing.';
    tester.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(500);
  const optionsState = await evaluate(`(() => ({
    title: document.title,
    heading: document.querySelector('h1')?.textContent || '',
    chips: document.querySelectorAll('#wordChips .chip').length,
    wordTotal: document.querySelector('#wordTotal')?.textContent || '',
    tester: document.querySelector('#testSummary')?.textContent || '',
    testerMarks: document.querySelectorAll('#testPreview mark').length,
    translationToggle: !!document.querySelector('#tryYouTubeTranslation'),
    openSubtitlesToggle: !!document.querySelector('#useOpenSubtitles'),
    openSubtitlesKey: !!document.querySelector('#openSubtitlesKey'),
    body: document.body.innerText.slice(0, 200)
  }))()`);
  notes.push(`options: ${JSON.stringify(optionsState)}`);
  assert.ok(/CleanVid/i.test(optionsState.title), 'Options page did not load.');
  assert.ok(optionsState.chips > 80, 'Options word list did not render.');
  assert.match(optionsState.tester, /2 matches/i, 'Options matcher tester did not run.');
  assert.equal(optionsState.testerMarks, 2, 'Options tester preview did not highlight matches.');
  assert.ok(optionsState.translationToggle && optionsState.openSubtitlesToggle && optionsState.openSubtitlesKey,
    'Optional subtitle-source controls did not render.');

  const layout = await cdp.send('Page.getLayoutMetrics');
  const optionsShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: layout.cssContentSize.width,
      height: layout.cssContentSize.height,
      scale: 1,
    },
  });
  fs.writeFileSync(
    path.join(outDir, 'e2e-options.png'),
    Buffer.from(optionsShot.data, 'base64')
  );
  notes.push('wrote tools/fixtures/e2e-options.png');

  await evaluate(`(async () => {
    const translation = document.querySelector('#tryYouTubeTranslation');
    translation.checked = true;
    translation.dispatchEvent(new Event('change', { bubbles: true }));
    const openSubtitles = document.querySelector('#useOpenSubtitles');
    openSubtitles.checked = true;
    await globalThis.CleanVid.constants.saveSettings({ useOpenSubtitles: true });
    document.querySelector('#openSubtitlesKey').value = 'e2e-test-key';
    document.querySelector('#saveOpenSubtitlesKey').click();
  })()`);
  await sleep(600);
  const sourceSettings = await evaluate(`new Promise((resolve) => chrome.storage.local.get(
    ['cleanvid.settings', 'cleanvid.openSubtitlesKey'], (values) => resolve({
      translation: values['cleanvid.settings']?.tryYouTubeTranslation,
      openSubtitles: values['cleanvid.settings']?.useOpenSubtitles,
      key: values['cleanvid.openSubtitlesKey']
    })
  ))`);
  notes.push(`optional source settings: ${JSON.stringify({ ...sourceSettings, key: sourceSettings.key ? 'saved' : '' })}`);
  assert.equal(sourceSettings.translation, true, 'Translation toggle was not saved.');
  assert.equal(sourceSettings.openSubtitles, true, 'OpenSubtitles toggle was not saved.');
  assert.equal(sourceSettings.key, 'e2e-test-key', 'OpenSubtitles key was not saved.');

  await evaluate(
    `new Promise((resolve) => chrome.storage.local.set(
      { 'cleanvid.words': { version: 1, words: [] } },
      resolve
    ))`
  );
  await cdp.send('Page.reload');
  await sleep(900);
  const emptyListState = await evaluate(`(() => ({
    wordTotal: document.querySelector('#wordTotal')?.textContent || '',
    chips: document.querySelectorAll('#wordChips .chip').length,
    note: document.querySelector('#noWords')?.textContent || ''
  }))()`);
  notes.push(`empty word list: ${JSON.stringify(emptyListState)}`);
  assert.equal(emptyListState.wordTotal, '0 words', 'Empty word list should stay empty.');
  assert.equal(emptyListState.chips, 0, 'Empty word list should render no chips.');
  assert.match(emptyListState.note, /list is empty/i, 'Empty word list should explain itself.');
  await evaluate(
    `new Promise((resolve) => chrome.storage.local.remove('cleanvid.words', resolve))`
  );

} catch (error) {
  issues.push(error.stack || error.message || String(error));
} finally {
  if (cdp) cdp.close();
  if (browserCdp) browserCdp.close();
  chrome.kill();
  await sleep(600);
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

if (errors.length) {
  console.log('\nChrome stderr mentions:');
  for (const line of errors) console.log(`  ${line.slice(0, 500)}`);
}
if (notes.length) {
  console.log('\nNotes:');
  for (const note of notes) console.log(`  · ${note}`);
}
if (issues.length) {
  console.error(`\nE2E smoke failed with ${issues.length} issue(s):`);
  for (const issue of issues) console.error(`  ✖ ${issue}`);
  process.exitCode = 1;
} else {
  console.log('\nE2E smoke passed.');
}
