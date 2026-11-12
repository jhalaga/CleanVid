/**
 * End-to-end test of on-device audio detection against a real YouTube video.
 *
 *   node tools/e2e-audio.mjs [--fresh] [--keep-cache] [videoId]
 *
 * 1. Loads the unpacked extension in headless Chrome with a persistent test
 *    profile (models download once, ~300 MB, then stay cached).
 * 2. Installs the speech models through the onboarding page if needed.
 * 3. Opens the video (ad fields are removed from the player response in this
 *    test browser only, so playback starts with content).
 * 4. Waits for the audio pipeline and checks the expected words were heard
 *    at the expected times.
 * 5. Reloads the page and checks the saved analysis is reused instantly
 *    (no new speech recognition).
 *
 * Expected moments are a regression baseline recorded from this pipeline and
 * spot-checked against the captions, not hand-labelled ground truth.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9367;
const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const keepCache = args.includes('--keep-cache');
const videoId = args.find((a) => !a.startsWith('--')) || 'LeWTK2y4QkA';

const BASELINES = {
  // Gordon Ramsay "You French Pig" (uncensored, 56 s)
  LeWTK2y4QkA: [
    { entry: /^fuck/, at: 6.3 },
    { entry: /^shit|bullshit/, at: 8.2 },
  ],
};
const expected = BASELINES[videoId] || [];
const TOLERANCE = 0.5;

const profile = process.env.CLEANVID_AUDIO_TEST_PROFILE || path.join(os.tmpdir(), 'cleanvid-e2e-audio-profile');
if (fresh) fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome was not found at ${CHROME}. Set CHROME_PATH and retry.`);
  process.exit(1);
}

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-extension-debugging',
  '--window-size=1280,900',
  '--lang=en-US',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notes = [];
const engineLog = [];

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
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
        for (const handler of this.handlers.get(message.method) || []) handler(message.params, message.sessionId);
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
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

let browser;
let page;
let failed = false;

try {
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) version = await response.json();
    } catch {
      /* retry */
    }
    if (!version) await sleep(200);
  }
  if (!version) throw new Error('Chrome DevTools endpoint did not start.');
  notes.push(`browser ${version.Browser}`);

  browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: ROOT });
  await browser.send('Target.setDiscoverTargets', { discover: true });
  browser.on('Runtime.consoleAPICalled', (params) => {
    const text = params.args.map((a) => a.value ?? a.description).join(' ');
    engineLog.push(text);
  });

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  page = new CDP(targets.find((t) => t.type === 'page' && t.url === 'about:blank').webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const evaluate = async (expression) => {
    const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };

  let engineSession = null;
  const engine = async (expression) => {
    if (!engineSession) {
      const { targetInfos } = await browser.send('Target.getTargets');
      const target = targetInfos.find((t) => t.url.includes('/src/engine/engine.html'));
      if (!target) return undefined;
      ({ sessionId: engineSession } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
      await browser.send('Runtime.enable', {}, engineSession);
    }
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, engineSession);
    return result.result ? result.result.value : undefined;
  };

  // --- Models ---------------------------------------------------------------
  await page.send('Page.navigate', { url: `chrome-extension://${extensionId}/src/onboarding/onboarding.html` });
  await page.send('Page.bringToFront');
  await sleep(2500);
  const installed = await evaluate(`!document.getElementById('doneBox').hidden`);
  if (!installed) {
    notes.push('installing models (first run)…');
    await evaluate(`document.getElementById('download').click()`);
    const started = Date.now();
    for (;;) {
      await sleep(2000);
      const state = await evaluate(`({ done: !document.getElementById('doneBox').hidden, error: document.getElementById('errorBox').textContent, value: document.getElementById('progressValue').textContent })`);
      if (state.done) break;
      if (state.error) throw new Error(`Model download failed: ${state.error}`);
      if (Date.now() - started > 20 * 60 * 1000) throw new Error('Model download timed out.');
    }
  }
  notes.push(`models: ${await evaluate(`document.getElementById('doneText').textContent`)}`);

  if (!keepCache) await engine('__cleanvidEngine.clearCache()');

  // --- Test-only ad removal ---------------------------------------------------
  await page.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*youtube.com/watch*', resourceType: 'Document', requestStage: 'Response' },
      { urlPattern: '*/youtubei/v1/player*', requestStage: 'Response' },
    ],
  });
  page.on('Fetch.requestPaused', async (params) => {
    try {
      const status = params.responseStatusCode || 200;
      if (status >= 300 && status < 400) {
        await page.send('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      const body = await page.send('Fetch.getResponseBody', { requestId: params.requestId });
      let text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      text = text.replace(/"(adPlacements|playerAds|adSlots|adBreakHeartbeatParams)"/g, '"$1Removed"');
      const headers = (params.responseHeaders || []).filter((h) => !/^(content-length|content-encoding)$/i.test(h.name));
      await page.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: status,
        responseHeaders: headers,
        body: Buffer.from(text, 'utf8').toString('base64'),
      });
    } catch {
      page.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    }
  });

  const panelState = `(() => {
    const host = document.getElementById('cleanvid-root');
    const root = host && host.shadowRoot;
    if (!root) return null;
    const q = (s) => root.querySelector(s)?.textContent || '';
    return {
      status: host.dataset.status,
      audio: host.dataset.audio,
      count: q('.cv-count'),
      pct: q('[data-ref=percent]'),
      audioText: q('[data-ref=audioText]'),
      stages: [...root.querySelectorAll('.cv-stage')].map((s) => s.dataset.state).join(','),
      rows: [...root.querySelectorAll('.cv-row')].map((r) => ({ seek: Number(r.dataset.seek), label: r.innerText.split(String.fromCharCode(10)).join(' ') })),
    };
  })()`;

  // --- Fresh analysis -----------------------------------------------------------
  await page.send('Page.navigate', { url: `https://www.youtube.com/watch?v=${videoId}` });
  await page.send('Page.bringToFront');
  const started = Date.now();
  let panel = null;
  for (;;) {
    await sleep(2000);
    panel = await evaluate(panelState).catch(() => null);
    const summary = await engine('JSON.stringify(__cleanvidEngine.summary())').catch(() => null);
    const job = summary ? JSON.parse(summary).find((j) => j.videoId === videoId) : null;
    const coveredEnough = job && job.coverage.length && job.coverage[0][1] >= Math.max(...expected.map((e) => e.at), 0) + 2;
    if (coveredEnough && panel) break;
    if (Date.now() - started > 180000) break;
  }
  const analyseMs = Date.now() - started;
  const words = JSON.parse(
    (await engine(`JSON.stringify([...__cleanvidEngine.jobs.get(${JSON.stringify(videoId)})?.words || []])`)) || '[]'
  );
  notes.push(`analysis wall time: ${analyseMs} ms, ${words.length} words heard`);
  notes.push(`word timing diagnostic: ${JSON.stringify(words.filter(w => w.t0 < 12).map(w => ({text:w.text,t0:w.t0,t1:w.t1})))}`);
  notes.push(`panel: ${JSON.stringify(panel)}`);
  notes.push(`engine: ${engineLog.filter((l) => /analysed|retry|failed|ready/.test(l)).slice(-8).join(' | ')}`);

  assert.ok(panel, 'CleanVid panel was not injected.');
  assert.equal(panel.audio, 'on', 'Audio detection should be active.');
  for (const item of expected) {
    const hit = panel.rows.find((row) => Math.abs(row.seek - item.at) <= TOLERANCE + 0.2);
    const word = words.find((w) => item.entry.test(String(w.text).toLowerCase().replace(/[^a-z]/g, '')) && Math.abs(w.t0 - item.at) <= TOLERANCE);
    assert.ok(word, `Expected "${item.entry}" to be heard near ${item.at}s.`);
    assert.ok(hit, `Expected a flagged row near ${item.at}s.`);
    notes.push(`✓ ${word.text} heard at ${word.t0.toFixed(2)}–${word.t1.toFixed(2)}s (baseline ${item.at}s)`);
  }

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, 'tools', 'fixtures', 'e2e-audio-page.png'), Buffer.from(shot.data, 'base64'));

  // --- Reload: saved analysis must be reused ---------------------------------------
  const coverageBefore = JSON.parse((await engine(
    `JSON.stringify(__cleanvidEngine.jobs.get(${JSON.stringify(videoId)})?.coverage || [])`
  )) || '[]');
  const analysedBefore = engineLog.filter((l) => l.includes(`analysed ${videoId}`)).length;
  await page.send('Page.reload', { ignoreCache: false });
  await page.send('Page.bringToFront');
  let cached = null;
  const reloadStart = Date.now();
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    cached = await evaluate(panelState).catch(() => null);
    if (cached && cached.rows.length >= expected.length && Number(cached.count) >= expected.length) break;
  }
  const cachedMs = Date.now() - reloadStart;
  const overlapping = engineLog
    .slice()
    .filter((l) => l.includes(`analysed ${videoId}`))
    .slice(analysedBefore)
    .filter((l) => {
      const m = l.match(/ (\d+\.\d+)–(\d+\.\d+) /);
      if (!m) return false;
      const start = Number(m[1]);
      const end = Number(m[2]);
      // New audio may fill an uncached gap near the start after reload.
      // Only count windows that repeat a previously covered range. Allow
      // 50 ms for rounded log timestamps and range-merging tolerances.
      return coverageBefore.some(([a, b]) => Math.min(end, b) - Math.max(start, a) > 0.05);
    });
  notes.push(`after reload: ${cached ? cached.count : '?'} moments shown within ${cachedMs} ms; re-analysed windows over the cached range: ${overlapping.length}`);
  assert.ok(cached && Number(cached.count) >= expected.length, 'Saved analysis should be shown after a reload.');
  assert.equal(overlapping.length, 0, 'Already analysed audio must not be analysed again after a reload.');
} catch (error) {
  failed = true;
  console.error(`\n✖ ${error.message}`);
} finally {
  console.log('\nNotes:');
  for (const note of notes) console.log(`  · ${note}`);
  try {
    page && page.close();
    browser && browser.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  console.log(failed ? '\nAudio E2E failed.' : '\nAudio E2E passed.');
  process.exit(failed ? 1 : 0);
}
