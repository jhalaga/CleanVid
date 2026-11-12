import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Load CleanVid's classic scripts into this process, like the extension does. */
export function loadCleanVid(...files) {
  globalThis.chrome = undefined;
  for (const file of files) {
    const full = path.join(ROOT, file);
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full });
  }
  return globalThis.CleanVid;
}

export function readFixture(name) {
  return fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', name), 'utf8');
}
