/**
 * CleanVid — Options page: audio detection card (models, muting style,
 * analysis cache). Talks to the offscreen engine for model and cache state.
 */
(() => {
  const { constants, EngineClient } = globalThis.CleanVid;
  const { MODEL_PACKS } = constants;
  const $ = (id) => document.getElementById(id);

  const els = {
    audioEnabled: $('audioEnabled'),
    modelPack: $('modelPack'),
    modelPackHint: $('modelPackHint'),
    modelBadge: $('modelBadge'),
    modelProgress: $('modelProgress'),
    modelProgressLabel: $('modelProgressLabel'),
    modelProgressValue: $('modelProgressValue'),
    modelProgressBar: $('modelProgressBar'),
    modelDownload: $('modelDownload'),
    modelRemove: $('modelRemove'),
    muteStyle: $('muteStyle'),
    audioPadding: $('audioPadding'),
    audioPaddingValue: $('audioPaddingValue'),
    pauseOnUnscanned: $('pauseOnUnscanned'),
    audioPrefetch: $('audioPrefetch'),
    cacheStats: $('cacheStats'),
    cacheClear: $('cacheClear'),
  };
  if (!els.audioEnabled) return;

  let settings = { ...constants.DEFAULT_SETTINGS };
  let model = { status: 'unknown' };
  let device = 'wasm';

  const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes > 1e8 ? 0 : 1)} MB`;

  for (const pack of Object.values(MODEL_PACKS)) {
    const option = document.createElement('option');
    option.value = pack.id;
    option.textContent = `${pack.label} — ${pack.short}`;
    els.modelPack.append(option);
  }

  function packHint() {
    const pack = MODEL_PACKS[els.modelPack.value] || MODEL_PACKS.standard;
    const size = pack.sizeMb[device] || pack.sizeMb.wasm;
    els.modelPackHint.textContent = `${pack.description} About ${size} MB on this computer (${
      device === 'webgpu' ? 'GPU' : 'CPU'
    }).`;
  }

  function renderModel() {
    const selected = els.modelPack.value;
    const installedPack = model.installed && model.installed.pack;
    const ready = model.status === 'ready' || model.status === 'installed';
    const loading = model.status === 'loading';
    const badge = els.modelBadge;
    badge.className = 'model-badge';
    if (loading) {
      badge.textContent = 'Downloading…';
      badge.classList.add('busy');
    } else if (ready && installedPack) {
      const pack = MODEL_PACKS[installedPack];
      badge.textContent = `${pack ? pack.label : 'Model'} installed · ${model.device === 'webgpu' ? 'GPU' : 'CPU'}`;
      badge.classList.add('ok');
    } else if (model.status === 'error') {
      badge.textContent = 'Download failed';
      badge.classList.add('bad');
    } else if (model.status === 'missing') {
      badge.textContent = 'Not installed';
      badge.classList.add('warn');
    } else {
      badge.textContent = 'Checking…';
    }

    els.modelProgress.hidden = !loading;
    if (loading) {
      const { loaded = 0, total = 0 } = model.progress || {};
      const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
      els.modelProgressLabel.textContent = total && loaded >= total * 0.995 ? 'Preparing models…' : 'Downloading models…';
      els.modelProgressValue.textContent = total ? `${mb(loaded)} / ${mb(total)}` : '';
      els.modelProgressBar.style.width = `${pct}%`;
    }

    const needsDownload = !installedPack || installedPack !== selected;
    els.modelDownload.hidden = !needsDownload && model.status !== 'error';
    els.modelDownload.disabled = loading;
    els.modelDownload.textContent = installedPack && installedPack !== selected
      ? `Switch to ${MODEL_PACKS[selected].label}`
      : model.status === 'error'
        ? 'Retry download'
        : 'Download models';
    els.modelRemove.hidden = !installedPack || loading;
  }

  const engine = EngineClient.create({
    onMessage(message) {
      if (!message) return;
      if (message.type === 'model') {
        model = message;
        renderModel();
      } else if (message.type === 'cache-stats') {
        const videos = message.videos || 0;
        els.cacheStats.textContent = `${videos} ${videos === 1 ? 'video' : 'videos'} analyzed · ${mb(
          message.storageBytes || 0
        )} used in total (models included)`;
      }
    },
  });

  function apply() {
    els.audioEnabled.checked = Boolean(settings.audioEnabled);
    if (MODEL_PACKS[settings.modelPack]) els.modelPack.value = settings.modelPack;
    els.muteStyle.value = settings.muteStyle === 'bleep' ? 'bleep' : 'silence';
    els.audioPadding.value = String(settings.audioPaddingMs);
    els.audioPaddingValue.textContent = `${settings.audioPaddingMs} ms`;
    els.pauseOnUnscanned.checked = Boolean(settings.pauseOnUnscanned);
    els.audioPrefetch.checked = Boolean(settings.audioPrefetch);
    packHint();
    renderModel();
  }

  async function save(patch) {
    settings = { ...settings, ...patch };
    try {
      await constants.saveSettings(patch);
    } catch {
      /* ignore */
    }
  }

  els.audioEnabled.addEventListener('change', () => save({ audioEnabled: els.audioEnabled.checked }));
  els.modelPack.addEventListener('change', () => {
    save({ modelPack: els.modelPack.value });
    packHint();
    renderModel();
  });
  els.muteStyle.addEventListener('change', () => save({ muteStyle: els.muteStyle.value }));
  els.audioPadding.addEventListener('input', () => {
    els.audioPaddingValue.textContent = `${els.audioPadding.value} ms`;
  });
  els.audioPadding.addEventListener('change', () => save({ audioPaddingMs: Number(els.audioPadding.value) }));
  els.pauseOnUnscanned.addEventListener('change', () => save({ pauseOnUnscanned: els.pauseOnUnscanned.checked }));
  els.audioPrefetch.addEventListener('change', () => save({ audioPrefetch: els.audioPrefetch.checked }));
  els.modelDownload.addEventListener('click', () => {
    save({ modelPack: els.modelPack.value, audioEnabled: true });
    model = { ...model, status: 'loading', progress: { loaded: 0, total: 0 } };
    renderModel();
    engine.post({ type: 'download', pack: els.modelPack.value });
  });
  els.modelRemove.addEventListener('click', () => {
    if (!confirm('Remove the downloaded speech models? CleanVid will use captions only until you download them again.')) return;
    engine.post({ type: 'remove-models' });
    engine.post({ type: 'cache-stats' });
  });
  els.cacheClear.addEventListener('click', () => {
    if (!confirm('Forget the saved audio analysis for every video? Videos will be analyzed again as you watch them.')) return;
    engine.post({ type: 'clear-cache' });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[constants.STORAGE_KEYS.settings]) return;
    settings = { ...constants.DEFAULT_SETTINGS, ...(changes[constants.STORAGE_KEYS.settings].newValue || {}) };
    apply();
  });

  (async () => {
    try {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      device = adapter ? 'webgpu' : 'wasm';
    } catch {
      device = 'wasm';
    }
    packHint();
  })();

  constants.getSettings().then((stored) => {
    settings = { ...constants.DEFAULT_SETTINGS, ...stored };
    apply();
  });
  engine.connect();
  engine.post({ type: 'status' });
  engine.post({ type: 'cache-stats' });
})();
