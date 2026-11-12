/**
 * CleanVid — on-device audio engine (offscreen document).
 *
 * One engine serves every YouTube tab. Content scripts stream the audio the
 * YouTube player buffers; the engine turns it into timed units, decides what
 * to analyse next (playhead first, then forward, then earlier gaps), runs
 *
 *   decode → Whisper (what was said) → wav2vec2 CTC (exactly when)
 *
 * and streams timed words back. Results are cached per video in IndexedDB,
 * so a refresh, revisit or seek never re-analyses the same audio.
 *
 * Only chrome.runtime is available in offscreen documents, so everything
 * persistent lives in IndexedDB / Cache Storage of the extension origin.
 */
const NS = globalThis.CleanVid;
const { constants, Media, Align, Timeline } = NS;
const { MODEL_PACKS, ALIGNER_MODEL, PIPELINE_VERSION } = constants;

const PORT_NAME = 'cleanvid-engine';
const SAMPLE_RATE = 16000;
const MAX_CHUNK = 27; // committed seconds per window (+1 s context each side)
const CONTEXT = 1;
const JOB_BYTE_BUDGET = 96 * 1024 * 1024;
const MAX_CACHED_VIDEOS = 400;
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const TRANSFORMERS_URL = chrome.runtime.getURL('vendor/transformers/transformers.min.js');
const ORT_MJS = chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs');
const ORT_WASM = chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm');

const log = (...args) => console.log('[CleanVid engine]', ...args);

// --- Clients ---------------------------------------------------------------

const clients = new Map(); // id -> client
let clientSeq = 0;
let idleTimer = null;

function send(client, message) {
  try {
    client.port.postMessage(message);
  } catch {
    /* port closed */
  }
}

function broadcast(message, filter = () => true) {
  for (const client of clients.values()) if (filter(client)) send(client, message);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const client = {
    id: ++clientSeq,
    port,
    kind: 'ui',
    videoId: null,
    playhead: 0,
    rate: 1,
    paused: true,
    lastActive: Date.now(),
    parsers: new Map(),
  };
  clients.set(client.id, client);
  clearTimeout(idleTimer);
  port.onMessage.addListener((message) => {
    handleMessage(client, message).catch((error) => {
      log('message failed', message && message.type, error);
      send(client, { type: 'error', error: errorText(error) });
    });
  });
  port.onDisconnect.addListener(() => {
    clients.delete(client.id);
    if (!clients.size) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!clients.size && !models.loading) {
          chrome.runtime.sendMessage({ type: 'engine-idle' }).catch(() => {});
        }
      }, IDLE_CLOSE_MS);
    }
  });
  installedPromise.then(() => send(client, { type: 'model', ...modelStatus() }));
});

function errorText(error) {
  return (error && (error.message || String(error))) || 'Unknown error';
}

async function handleMessage(client, message) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'hello': {
      client.kind = 'tab';
      client.videoId = String(message.videoId || '') || null;
      client.lastActive = Date.now();
      client.parsers.clear();
      if (!client.videoId) return;
      const job = getJob(client.videoId);
      if (Number(message.duration) > 0) job.duration = Number(message.duration);
      await Promise.all([job.loaded, installedPromise]);
      send(client, videoMessage(job));
      send(client, { type: 'model', ...modelStatus() });
      if (message.autoLoad !== false) autoLoadModels(message.pack);
      wake();
      return;
    }
    case 'duration': {
      const job = client.videoId && jobs.get(client.videoId);
      if (job && Number(message.duration) > 0) job.duration = Number(message.duration);
      return;
    }
    case 'append':
      receiveAudio(client, message);
      return;
    case 'reset': {
      const entry = client.parsers.get(String(message.key));
      if (entry) entry.parser.reset();
      return;
    }
    case 'playhead': {
      const moved = Math.abs((Number(message.time) || 0) - client.playhead) > 2;
      client.playhead = Number(message.time) || 0;
      client.rate = Number(message.rate) || 1;
      client.paused = Boolean(message.paused);
      client.lastActive = Date.now();
      if (moved) wake();
      return;
    }
    case 'status':
      await installedPromise;
      send(client, { type: 'model', ...modelStatus() });
      return;
    case 'download':
      loadModels(String(message.pack || 'standard'), { userInitiated: true }).catch(() => {});
      return;
    case 'remove-models':
      await removeModels();
      broadcast({ type: 'model', ...modelStatus() });
      return;
    case 'cache-stats':
      send(client, { type: 'cache-stats', ...(await cacheStats()) });
      return;
    case 'clear-cache':
      await clearVideoCache();
      send(client, { type: 'cache-stats', ...(await cacheStats()) });
      return;
    case 'forget-video': {
      const id = String(message.videoId || '');
      if (!id) return;
      const job = jobs.get(id);
      if (job) {
        job.coverage = [];
        job.failed = [];
        job.words = [];
        job.ctc = [];
      }
      await dbDelete('videos', id).catch(() => {});
      broadcast(job ? videoMessage(job) : { type: 'video', videoId: id, coverage: [], words: [], ctc: [] }, (c) => c.videoId === id);
      wake();
      return;
    }
    default:
  }
}

// --- IndexedDB ---------------------------------------------------------------

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('cleanvid-engine', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const videos = database.createObjectStore('videos', { keyPath: 'videoId' });
        videos.createIndex('lastAccess', 'lastAccess');
        database.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const objectStore = transaction.objectStore(store);
    let result;
    Promise.resolve(fn(objectStore)).then((value) => {
      result = value;
    });
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const req = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const dbGet = (store, key) => tx(store, 'readonly', (s) => req(s.get(key)));
const dbPut = (store, value) => tx(store, 'readwrite', (s) => req(s.put(value)));
const dbDelete = (store, key) => tx(store, 'readwrite', (s) => req(s.delete(key)));

async function cacheStats() {
  try {
    const count = await tx('videos', 'readonly', (s) => req(s.count()));
    let bytes = 0;
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      bytes = estimate.usage || 0;
    }
    return { videos: count, storageBytes: bytes };
  } catch (error) {
    return { videos: 0, storageBytes: 0, error: errorText(error) };
  }
}

async function clearVideoCache() {
  await tx('videos', 'readwrite', (s) => req(s.clear()));
  for (const job of jobs.values()) {
    job.coverage = [];
    job.failed = [];
    job.words = [];
    job.ctc = [];
    broadcast(videoMessage(job), (c) => c.videoId === job.videoId);
  }
  wake();
}

async function pruneVideos() {
  try {
    const count = await tx('videos', 'readonly', (s) => req(s.count()));
    if (count <= MAX_CACHED_VIDEOS) return;
    await tx('videos', 'readwrite', (store) => {
      let remove = count - MAX_CACHED_VIDEOS;
      const cursorRequest = store.index('lastAccess').openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || remove <= 0) return;
        if (!jobs.has(cursor.value.videoId)) {
          cursor.delete();
          remove -= 1;
        }
        cursor.continue();
      };
    });
  } catch {
    /* best effort */
  }
}

// --- Jobs (one per video) ------------------------------------------------------

const jobs = new Map();

function currentVersion() {
  return `${models.pack || 'none'}:${PIPELINE_VERSION}`;
}

const round3 = (value) => Math.round(value * 1000) / 1000;
const packWords = (list) => list.map((w) => [round3(w.t0), round3(w.t1), w.text, round3(w.conf || 0)]);
const unpackWords = (list) =>
  (Array.isArray(list) ? list : []).map((w) => ({ t0: w[0], t1: w[1], text: w[2], conf: w[3] }));

function getJob(videoId) {
  let job = jobs.get(videoId);
  if (job) {
    job.lastTouched = Date.now();
    return job;
  }
  job = {
    videoId,
    duration: 0,
    coverage: [],
    failed: [],
    words: [],
    ctc: [],
    version: null,
    units: [],
    inits: new Map(),
    bytes: 0,
    lastAudioAt: 0,
    lastTouched: Date.now(),
    saveTimer: null,
    availableTimer: null,
  };
  job.loaded = (async () => {
    try {
      const record = await dbGet('videos', videoId);
      if (record) {
        job.version = record.version;
        job.coverage = Timeline.normalize(record.coverage || []);
        job.words = unpackWords(record.words);
        job.ctc = unpackWords(record.ctc);
        if (record.duration > 0 && !job.duration) job.duration = record.duration;
        record.lastAccess = Date.now();
        dbPut('videos', record).catch(() => {});
      }
    } catch (error) {
      log('cache read failed', error);
    }
  })();
  jobs.set(videoId, job);
  // Forget idle jobs (their audio bytes) but keep a few for quick back/forward.
  if (jobs.size > 6) {
    const idle = [...jobs.values()]
      .filter((other) => other !== job && ![...clients.values()].some((c) => c.videoId === other.videoId))
      .sort((a, b) => a.lastTouched - b.lastTouched);
    for (const other of idle.slice(0, jobs.size - 6)) jobs.delete(other.videoId);
  }
  return job;
}

/** Drop cached results made by a different model/pipeline. */
function reconcileVersion(job) {
  const version = currentVersion();
  if (!models.ready) return;
  if (job.version && job.version !== version && job.coverage.length) {
    log('discarding cache made by', job.version, 'for', job.videoId);
    job.coverage = [];
    job.words = [];
    job.ctc = [];
    job.failed = [];
    broadcast(videoMessage(job), (c) => c.videoId === job.videoId);
  }
  job.version = version;
}

function videoMessage(job) {
  return {
    type: 'video',
    videoId: job.videoId,
    coverage: job.coverage,
    available: availableRanges(job),
    words: packWords(job.words),
    ctc: packWords(job.ctc),
  };
}

function scheduleSave(job) {
  clearTimeout(job.saveTimer);
  job.saveTimer = setTimeout(() => {
    dbPut('videos', {
      videoId: job.videoId,
      version: job.version || currentVersion(),
      duration: job.duration,
      coverage: job.coverage,
      words: packWords(job.words),
      ctc: packWords(job.ctc),
      lastAccess: Date.now(),
      updatedAt: Date.now(),
    })
      .then(pruneVideos)
      .catch((error) => log('cache write failed', error));
  }, 600);
}

function availableRanges(job) {
  return Timeline.normalize(
    job.units.map((unit) => [unit.start, unit.start + unit.duration]),
    0.12
  );
}

function receiveAudio(client, message) {
  if (!client.videoId || message.videoId !== client.videoId) return;
  const job = getJob(client.videoId);
  const key = String(message.key || 'audio');
  let entry = client.parsers.get(key);
  if (!entry || entry.mime !== message.mime) {
    const parser = Media.createParser(message.mime);
    if (!parser) return;
    entry = { parser, mime: message.mime, initKey: '' };
    client.parsers.set(key, entry);
  }
  const bytes = Media.bytesFromBase64(message.b64);
  const result = entry.parser.push(bytes, Number(message.offset) || 0);
  if (result.init) {
    entry.initKey = `${client.id}:${key}:${Date.now()}`;
    job.inits.set(entry.initKey, result.init);
  }
  let added = 0;
  for (const unit of result.units) {
    if (!entry.initKey || !(unit.duration > 0.05) || !Number.isFinite(unit.start) || unit.start < -1) continue;
    const duplicate = job.units.some(
      (other) => Math.abs(other.start - unit.start) < 0.02 && Math.abs(other.duration - unit.duration) < 0.05
    );
    if (duplicate) continue;
    unit.initKey = entry.initKey;
    job.units.push(unit);
    job.bytes += unit.bytes.length;
    added += 1;
  }
  if (!added) return;
  job.units.sort((a, b) => a.start - b.start);
  job.lastAudioAt = Date.now();
  evictAudio(job);
  clearTimeout(job.availableTimer);
  job.availableTimer = setTimeout(() => {
    broadcast(
      { type: 'available', videoId: job.videoId, available: availableRanges(job) },
      (c) => c.videoId === job.videoId
    );
  }, 250);
  wake();
}

/** Free audio bytes that are analysed and not needed as context any more. */
function evictAudio(job) {
  if (globalThis.__cleanvidKeepAudio) return;
  const done = Timeline.normalize([...job.coverage, ...job.failed], 0.1);
  const keep = [];
  let bytes = 0;
  for (const unit of job.units) {
    const span = [[unit.start - 1.5, unit.start + unit.duration + 1.5]];
    const needed = Timeline.subtract(span, done).length > 0;
    if (needed) {
      keep.push(unit);
      bytes += unit.bytes.length;
    }
  }
  job.units = keep;
  job.bytes = bytes;
  if (job.bytes > JOB_BYTE_BUDGET) {
    const playhead = playheadFor(job);
    const byDistance = [...job.units].sort(
      (a, b) => Math.abs(b.start - playhead) - Math.abs(a.start - playhead)
    );
    while (job.bytes > JOB_BYTE_BUDGET * 0.8 && byDistance.length) {
      const victim = byDistance.shift();
      job.units.splice(job.units.indexOf(victim), 1);
      job.bytes -= victim.bytes.length;
    }
  }
  const usedInits = new Set(job.units.map((unit) => unit.initKey));
  for (const key of job.inits.keys()) {
    if (!usedInits.has(key) && ![...clients.values()].some((c) => [...c.parsers.values()].some((p) => p.initKey === key))) {
      job.inits.delete(key);
    }
  }
}

function playheadFor(job) {
  let best = null;
  for (const client of clients.values()) {
    if (client.videoId !== job.videoId) continue;
    if (!best || client.lastActive > best.lastActive) best = client;
  }
  return best ? best.playhead : 0;
}

// --- Models --------------------------------------------------------------------

const models = {
  pack: null,
  device: null,
  ready: false,
  loading: false,
  error: '',
  progress: { loaded: 0, total: 0, file: '' },
  installed: null, // { pack, device } from IndexedDB
  asr: null,
  processor: null,
  ctc: null,
  transformers: null,
  loadPromise: null,
};

const installedPromise = dbGet('meta', 'models')
  .then((record) => {
    models.installed = record || null;
  })
  .catch(() => {
    models.installed = null;
  });

function modelStatus() {
  return {
    status: models.ready ? 'ready' : models.loading ? 'loading' : models.error ? 'error' : models.installed ? 'installed' : 'missing',
    pack: models.pack || (models.installed && models.installed.pack) || null,
    device: models.device || (models.installed && models.installed.device) || null,
    installed: models.installed,
    error: models.error,
    progress: models.progress,
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
  };
}

let lastProgressAt = 0;
function reportProgress(force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < 200) return;
  lastProgressAt = now;
  broadcast({ type: 'model', ...modelStatus() });
}

async function detectDevice() {
  try {
    if (!navigator.gpu) return 'wasm';
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

async function transformers() {
  if (models.transformers) return models.transformers;
  const T = await import(TRANSFORMERS_URL);
  T.env.allowLocalModels = false;
  T.env.allowRemoteModels = true;
  T.env.useBrowserCache = true;
  T.env.useWasmCache = false; // a blob: factory would violate the extension CSP
  const onnx = T.env.backends.onnx;
  onnx.wasm.wasmPaths = { mjs: ORT_MJS, wasm: ORT_WASM };
  onnx.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
    : 1;
  onnx.wasm.proxy = false;
  models.transformers = T;
  return T;
}

function autoLoadModels(requestedPack) {
  installedPromise.then(() => {
    if (models.ready || models.loading) return;
    if (!models.installed) return; // never download without consent
    const pack = MODEL_PACKS[requestedPack] && models.installed.pack === requestedPack
      ? requestedPack
      : models.installed.pack;
    loadModels(pack).catch(() => {});
  });
}

async function loadModels(packId, { userInitiated = false } = {}) {
  const pack = MODEL_PACKS[packId] || MODEL_PACKS.standard;
  if (models.ready && models.pack === pack.id) return;
  if (models.loadPromise) {
    await models.loadPromise.catch(() => {});
    if (models.ready && models.pack === pack.id) return;
  }
  models.loadPromise = (async () => {
    models.loading = true;
    models.error = '';
    models.ready = false;
    models.progress = { loaded: 0, total: 0, file: '' };
    reportProgress(true);
    const files = new Map();
    const progress_callback = (event) => {
      if (!event || !event.file) return;
      const key = `${event.name || ''}/${event.file}`;
      if (event.status === 'progress' || event.status === 'done') {
        const prev = files.get(key) || { loaded: 0, total: 0 };
        const total = Number(event.total) || prev.total;
        const loaded = event.status === 'done' ? total || prev.loaded : Number(event.loaded) || prev.loaded;
        files.set(key, { loaded, total });
      } else if (event.status === 'initiate') {
        if (!files.has(key)) files.set(key, { loaded: 0, total: 0 });
      }
      let loaded = 0;
      let total = 0;
      for (const value of files.values()) {
        loaded += value.loaded;
        total += value.total;
      }
      models.progress = { loaded, total, file: event.file };
      reportProgress();
    };

    try {
      await disposeModels();
      const T = await transformers();
      let device = await detectDevice();
      const load = async (dev) => {
        const dtype = dev === 'webgpu'
          ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
          : { encoder_model: 'q8', decoder_model_merged: 'q8' };
        return T.pipeline('automatic-speech-recognition', pack.whisper.model, {
          revision: pack.whisper.revision,
          device: dev,
          dtype,
          progress_callback,
        });
      };
      let asr;
      try {
        asr = await load(device);
      } catch (error) {
        if (device !== 'webgpu') throw error;
        log('WebGPU load failed, falling back to WASM', error);
        device = 'wasm';
        asr = await load(device);
      }
      const processor = await T.AutoProcessor.from_pretrained(ALIGNER_MODEL.model, {
        revision: ALIGNER_MODEL.revision,
        progress_callback,
      });
      const ctc = await T.AutoModelForCTC.from_pretrained(ALIGNER_MODEL.model, {
        revision: ALIGNER_MODEL.revision,
        device: 'wasm',
        dtype: 'q8',
        progress_callback,
      });
      Object.assign(models, { asr, processor, ctc, pack: pack.id, device, ready: true, loading: false });
      models.installed = { key: 'models', pack: pack.id, device, installedAt: Date.now() };
      await dbPut('meta', models.installed).catch(() => {});
      log('models ready', pack.id, device, 'threads', T.env.backends.onnx.wasm.numThreads);
      for (const job of jobs.values()) reconcileVersion(job);
      reportProgress(true);
      wake();
    } catch (error) {
      models.loading = false;
      models.ready = false;
      models.error = errorText(error);
      log('model load failed', error);
      reportProgress(true);
      if (userInitiated) throw error;
    } finally {
      models.loading = false;
    }
  })();
  try {
    await models.loadPromise;
  } finally {
    models.loadPromise = null;
  }
}

async function disposeModels() {
  for (const key of ['asr', 'ctc']) {
    try {
      const value = models[key];
      if (value && typeof value.dispose === 'function') await value.dispose();
    } catch {
      /* ignore */
    }
    models[key] = null;
  }
  models.processor = null;
  models.ready = false;
}

async function removeModels() {
  await disposeModels();
  models.pack = null;
  models.device = null;
  models.error = '';
  models.installed = null;
  models.progress = { loaded: 0, total: 0, file: '' };
  await dbDelete('meta', 'models').catch(() => {});
  try {
    await caches.delete('transformers-cache');
  } catch {
    /* ignore */
  }
}

// --- Decoding --------------------------------------------------------------------

async function decodeWindow(job, window) {
  const startUnit = job.units.find(
    (unit) => unit.start <= window.audioStart + 0.05 && unit.start + unit.duration > window.audioStart
  ) || job.units.find((unit) => unit.start + unit.duration > window.audioStart);
  if (!startUnit) throw new Error('No audio for window');
  const initKey = startUnit.initKey;
  const init = job.inits.get(initKey);
  if (!init) throw new Error('Missing init segment');
  const run = [];
  let end = -Infinity;
  for (const unit of job.units) {
    if (unit.initKey !== initKey) continue;
    if (unit.start + unit.duration <= window.audioStart) continue;
    if (unit.start >= window.audioEnd) break;
    if (run.length && unit.start > end + 0.12) break; // gap
    if (run.length && unit.start < end - 0.5) continue; // overlap duplicate
    run.push(unit);
    end = unit.start + unit.duration;
  }
  if (!run.length) throw new Error('No contiguous audio');

  const bytes = Media.buildDecodable(init, run);
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const expected = run.reduce((sum, unit) => sum + unit.duration, 0);
  const actual = buffer.length / SAMPLE_RATE;
  const trimmed = expected - actual;
  // Decoders drop pre-skip / priming samples at the start of a decode.
  const pcmStart = run[0].start + (trimmed > 0 && trimmed < 0.2 ? trimmed : 0);

  let mono;
  if (buffer.numberOfChannels === 1) mono = buffer.getChannelData(0);
  else {
    mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
  }
  const from = Math.max(0, Math.round((window.audioStart - pcmStart) * SAMPLE_RATE));
  const to = Math.min(mono.length, Math.round((window.audioEnd - pcmStart) * SAMPLE_RATE));
  const audioStart = pcmStart + from / SAMPLE_RATE;
  return { samples: mono.slice(from, to), audioStart, audioEnd: pcmStart + to / SAMPLE_RATE };
}

// --- Analysis ----------------------------------------------------------------------

let running = false;
let idleCheck = null;

function wake() {
  if (running) return;
  running = true;
  Promise.resolve()
    .then(loop)
    .catch((error) => log('loop failed', error))
    .finally(() => {
      running = false;
    });
}

function pickTask() {
  if (!models.ready) return null;
  const active = [...clients.values()]
    .filter((client) => client.kind === 'tab' && client.videoId && jobs.has(client.videoId))
    .sort((a, b) => Number(a.paused) - Number(b.paused) || b.lastActive - a.lastActive);
  const seen = new Set();
  for (const client of active) {
    if (seen.has(client.videoId)) continue;
    seen.add(client.videoId);
    const job = jobs.get(client.videoId);
    if (!job.units.length) continue;
    const window = Timeline.nextWindow({
      available: availableRanges(job),
      coverage: Timeline.normalize([...job.coverage, ...job.failed], 0.05),
      playhead: client.playhead,
      duration: job.duration,
      maxChunk: MAX_CHUNK,
      context: CONTEXT,
      waitedMs: Date.now() - job.lastAudioAt,
    });
    if (window) return { job, window };
  }
  return null;
}

async function loop() {
  clearTimeout(idleCheck);
  for (;;) {
    const task = pickTask();
    if (!task) break;
    await analyse(task.job, task.window);
  }
  // Short tails wait for more audio; re-check later.
  if ([...jobs.values()].some((job) => job.units.length)) {
    idleCheck = setTimeout(wake, 2500);
  }
}

/**
 * Whisper with a completeness check. Whisper occasionally stops after the
 * first sentence of a window (it predicts end-of-text early on noisy or
 * shouted speech). If the acoustic model heard far more words than Whisper
 * wrote, split the audio at the quietest point near the middle and
 * transcribe each half again.
 */
async function transcribe(samples, acousticWords, depth) {
  const out = await models.asr(samples, { return_timestamps: false });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : (out && out.text) || '';
  const tokens = Align.transcriptWords(text);
  const seconds = samples.length / SAMPLE_RATE;
  const incomplete = acousticWords >= 6 && tokens.length < acousticWords * 0.6;
  if (!incomplete || depth >= 2 || seconds < 6) return tokens;
  const cut = quietestPoint(samples, Math.floor(samples.length / 2), Math.floor(SAMPLE_RATE * 3));
  const left = samples.subarray(0, cut);
  const right = samples.subarray(cut);
  const share = cut / samples.length;
  const leftTokens = await transcribe(left, Math.round(acousticWords * share), depth + 1);
  const rightTokens = await transcribe(right, Math.round(acousticWords * (1 - share)), depth + 1);
  const merged = leftTokens.concat(rightTokens);
  log(`whisper retry (depth ${depth}): ${tokens.length} → ${merged.length} words, acoustic ${acousticWords}`);
  return merged.length > tokens.length ? merged : tokens;
}

/** Sample index of the lowest-energy 50 ms frame within ±range of `center`. */
function quietestPoint(samples, center, range) {
  const frame = Math.floor(SAMPLE_RATE * 0.05);
  let best = center;
  let bestEnergy = Infinity;
  const from = Math.max(frame, center - range);
  const to = Math.min(samples.length - frame, center + range);
  for (let start = from; start < to; start += frame / 2) {
    let energy = 0;
    for (let i = start; i < start + frame; i++) energy += samples[i] * samples[i];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start + (frame >> 1);
    }
  }
  return best;
}

function stage(job, name, window) {
  broadcast(
    { type: 'stage', videoId: job.videoId, stage: name, range: window ? [window.start, window.commitEnd] : null },
    (c) => c.videoId === job.videoId
  );
}

async function analyse(job, window) {
  const started = performance.now();
  reconcileVersion(job);
  try {
    stage(job, 'decoding', window);
    const audio = await decodeWindow(job, window);
    if (audio.samples.length < SAMPLE_RATE * 0.3) throw new Error('Window too short');

    // Acoustic pass first: it is cheap, and its greedy transcript tells us how
    // much speech the window really contains.
    stage(job, 'transcribing', window);
    const inputs = await models.processor(audio.samples);
    const output = await models.ctc(inputs);
    const logits = output.logits;
    const [, frames, vocab] = logits.dims;
    const logp = Align.logSoftmax(logits.data, frames, vocab);
    const frameSec = audio.samples.length / SAMPLE_RATE / frames;
    const options = { frameSec, offset: audio.audioStart };
    const greedy = Align.greedyWords(logp, frames, vocab, options);

    const tokens = await transcribe(audio.samples, greedy.length, 0);

    stage(job, 'aligning', window);
    const aligned = Align.alignWords(logp, frames, vocab, tokens, options);

    const inWindow = (word) => {
      const mid = (word.t0 + word.t1) / 2;
      return mid >= window.start && mid < window.commitEnd;
    };
    const words = aligned.filter(inWindow);
    const ctcWords = greedy.filter(inWindow);
    job.words = Timeline.spliceWords(job.words, words, window.start, window.commitEnd);
    job.ctc = Timeline.spliceWords(job.ctc, ctcWords, window.start, window.commitEnd);
    job.coverage = Timeline.add(job.coverage, [window.start, window.commitEnd], 0.05);
    scheduleSave(job);

    const ms = Math.round(performance.now() - started);
    log(
      `analysed ${job.videoId} ${window.start.toFixed(2)}–${window.commitEnd.toFixed(2)} in ${ms} ms`,
      `(${words.length} words)`
    );
    broadcast(
      {
        type: 'chunk',
        videoId: job.videoId,
        range: [window.start, window.commitEnd],
        words: packWords(words),
        ctc: packWords(ctcWords),
        coverage: job.coverage,
        ms,
        rtf: Math.round(((window.commitEnd - window.start) / Math.max(0.001, ms / 1000)) * 10) / 10,
      },
      (c) => c.videoId === job.videoId
    );
  } catch (error) {
    log('window failed', job.videoId, window, error);
    job.failed = Timeline.add(job.failed, [window.start, window.commitEnd], 0.05);
    broadcast(
      { type: 'stage', videoId: job.videoId, stage: 'error', error: errorText(error), range: [window.start, window.commitEnd] },
      (c) => c.videoId === job.videoId
    );
  } finally {
    evictAudio(job);
    stage(job, 'idle', null);
  }
}

// Let the service worker know the listeners are in place.
chrome.runtime.sendMessage({ type: 'engine-ready' }).catch(() => {});
log('engine started; crossOriginIsolated =', globalThis.crossOriginIsolated);

// Read-only handle for diagnostics from DevTools (chrome://inspect → offscreen).
globalThis.__cleanvidEngine = {
  jobs,
  clients,
  models,
  async debugWindow(videoId, start, end, options = {}) {
    const job = jobs.get(videoId);
    const audio = await decodeWindow(job, { audioStart: start, audioEnd: end });
    const out = await models.asr(audio.samples, options);
    return { seconds: audio.samples.length / SAMPLE_RATE, out };
  },
  clearCache: () => clearVideoCache(),
  summary() {
    return [...jobs.values()].map((job) => ({
      videoId: job.videoId,
      units: job.units.length,
      bytes: job.bytes,
      available: availableRanges(job),
      coverage: job.coverage,
      failed: job.failed,
      words: job.words.length,
    }));
  },
};
