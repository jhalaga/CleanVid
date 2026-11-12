import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCleanVid } from './helpers/load.mjs';

const { constants } = loadCleanVid('src/shared/constants.js');
const data = {
  [constants.STORAGE_KEYS.settings]: {
    enabled: false,
    tryYouTubeTranslation: false,
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return { [key]: data[key] };
      },
      async set(values) {
        Object.assign(data, values);
      },
    },
  },
};

test('translation scanning defaults on and upgrades older saved settings once', async () => {
  assert.equal(constants.DEFAULT_SETTINGS.tryYouTubeTranslation, true);
  const migrated = await constants.getSettings();
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.tryYouTubeTranslation, true);
  assert.equal(migrated.captionSourceVersion, 1);

  await constants.saveSettings({ tryYouTubeTranslation: false });
  assert.equal((await constants.getSettings()).tryYouTubeTranslation, false);
});
