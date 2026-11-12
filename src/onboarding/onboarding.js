/**
 * CleanVid — first-run onboarding: explain the on-device models and download
 * them through the engine (which also warms them up).
 */
(() => {
  const { constants, EngineClient } = globalThis.CleanVid;
  const { MODEL_PACKS } = constants;
  const $ = (id) => document.getElementById(id);

  let selected = 'standard';
  let device = 'wasm';
  let downloading = false;

  const formatMb = (bytes) => `${(bytes / 1e6).toFixed(bytes > 1e8 ? 0 : 1)} MB`;

  function renderPacks() {
    const box = $('packs');
    box.textContent = '';
    for (const pack of Object.values(MODEL_PACKS)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ob-pack';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(pack.id === selected));
      button.dataset.pack = pack.id;
      const size = pack.sizeMb[device] || pack.sizeMb.wasm;
      button.innerHTML = `
        <span class="ob-pack-top"><strong></strong><span class="ob-size"></span></span>
        <span class="ob-tag"></span>
        <small></small>`;
      button.querySelector('strong').textContent = pack.label;
      button.querySelector('.ob-size').textContent = `≈ ${size} MB`;
      button.querySelector('.ob-tag').textContent = pack.short;
      button.querySelector('small').textContent = pack.description;
      button.addEventListener('click', () => {
        if (downloading) return;
        selected = pack.id;
        renderPacks();
      });
      box.append(button);
    }
  }

  async function detect() {
    const badge = $('deviceBadge');
    try {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      device = adapter ? 'webgpu' : 'wasm';
    } catch {
      device = 'wasm';
    }
    badge.textContent = device === 'webgpu' ? 'GPU acceleration available' : 'Runs on CPU (no WebGPU)';
    badge.classList.toggle('cpu', device !== 'webgpu');
    renderPacks();
  }

  function showError(message) {
    const box = $('errorBox');
    box.hidden = !message;
    box.textContent = message || '';
  }

  function onModel(status) {
    const box = $('progressBox');
    const bar = $('progressBar');
    if (status.status === 'loading') {
      downloading = true;
      box.hidden = false;
      $('download').disabled = true;
      const { loaded = 0, total = 0, file = '' } = status.progress || {};
      const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
      const finishing = total && loaded >= total * 0.995;
      $('progressLabel').textContent = finishing ? 'Preparing models…' : 'Downloading models…';
      $('progressValue').textContent = total ? `${formatMb(loaded)} / ${formatMb(total)}` : '';
      bar.classList.toggle('indeterminate', !total || finishing);
      bar.style.width = `${pct}%`;
      $('progressFile').textContent = file ? file.split('/').pop() : '';
      showError('');
    } else if (status.status === 'ready' || (status.status === 'installed' && !downloading)) {
      downloading = false;
      box.hidden = true;
      $('doneBox').hidden = false;
      $('download').hidden = true;
      $('skip').hidden = true;
      $('openYoutube').hidden = false;
      const pack = MODEL_PACKS[status.pack] || MODEL_PACKS[status.installed && status.installed.pack];
      $('doneText').textContent = `${pack ? pack.label : 'Model'} pack installed${
        status.device === 'webgpu' ? ' (GPU accelerated)' : ' (CPU)'
      }. Open any YouTube video; CleanVid starts listening as soon as the player loads.`;
      showError('');
    } else if (status.status === 'error') {
      downloading = false;
      box.hidden = true;
      $('download').disabled = false;
      $('download').textContent = 'Try again';
      showError(`The download did not finish: ${status.error}. Check your connection and try again.`);
    }
  }

  const engine = EngineClient.create({
    onMessage(message) {
      if (message && message.type === 'model') onModel(message);
    },
  });

  $('download').addEventListener('click', async () => {
    if (downloading) return;
    downloading = true;
    $('download').disabled = true;
    $('progressBox').hidden = false;
    $('progressLabel').textContent = 'Starting…';
    $('progressBar').classList.add('indeterminate');
    try {
      await constants.saveSettings({ modelPack: selected, audioEnabled: true });
    } catch {
      /* ignore */
    }
    engine.post({ type: 'download', pack: selected });
  });

  $('skip').addEventListener('click', () => {
    window.close();
  });

  try {
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    /* ignore */
  }

  constants
    .getSettings()
    .then((settings) => {
      if (MODEL_PACKS[settings.modelPack]) selected = settings.modelPack;
      renderPacks();
    })
    .catch(() => {});
  renderPacks();
  detect();
  engine.connect();
  engine.post({ type: 'status' });
})();
