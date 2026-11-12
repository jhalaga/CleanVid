/**
 * Static validation for the unpacked extension.
 * Usage: node tools/check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const errors = [];
const referenced = new Set();
const notes = [];

function fail(message) {
  errors.push(message);
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function walk(directory) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(relative));
    else out.push(relative);
  }
  return out;
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3.');
  if (!manifest.name) fail('manifest name is missing.');
  if (!manifest.version) fail('manifest version is missing.');
  if (!manifest.action) fail('Toolbar action is missing.');
  if (manifest.action?.default_popup) fail('Toolbar must use the shared floating panel, not a separate popup.');

  const add = (value) => value && referenced.add(value.replace(/^\//, ''));

  add(manifest.background && manifest.background.service_worker);
  add(manifest.options_ui && manifest.options_ui.page);
  add(manifest.action && manifest.action.default_popup);

  for (const size of Object.values((manifest.action && manifest.action.default_icon) || {})) add(size);
  for (const size of Object.values(manifest.icons || {})) add(size);

  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  for (const resource of manifest.web_accessible_resources || []) {
    for (const file of resource.resources || []) add(file);
  }

  for (const file of referenced) {
    if (!exists(file)) fail(`Manifest references a missing file: ${file}`);
  }

  const scripts = manifest.content_scripts || [];
  const main = scripts.find((script) => script.world === 'MAIN');
  const isolated = scripts.find((script) => script.world !== 'MAIN');
  if (!main) fail('No MAIN-world content script found.');
  if (!isolated) fail('No isolated-world content script found.');
  if (main && isolated && main.run_at !== 'document_start') {
    fail('The MAIN-world bridge should run at document_start.');
  }
  if (isolated) {
    for (const file of [
      'src/shared/constants.js',
      'src/shared/matching.js',
      'src/shared/captions.js',
      'src/content/content.js',
    ]) {
      if (!(isolated.js || []).includes(file)) fail(`Isolated content script is missing ${file}.`);
    }
  }

  const panelCss = (manifest.web_accessible_resources || []).some((resource) =>
    (resource.resources || []).includes('src/content/panel.css')
  );
  if (!panelCss) fail('panel.css must be web-accessible for the shadow-DOM panel.');
}

const jsFiles = walk('src').concat(walk('tools')).filter((file) => file.endsWith('.js'));
for (const file of jsFiles.filter((file) => !file.includes('tools/test-matching'))) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`${file} failed syntax check:\n${result.stderr || result.stdout}`);
  }
}

// Validate PNG headers and dimensions.
for (const [file, expected] of [
  ['icons/icon16.png', 16],
  ['icons/icon32.png', 32],
  ['icons/icon48.png', 48],
  ['icons/icon128.png', 128],
]) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    fail(`Missing icon: ${file}`);
    continue;
  }
  const buffer = fs.readFileSync(full);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    fail(`${file} is not a PNG.`);
    continue;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expected || height !== expected) {
    fail(`${file} is ${width}x${height}, expected ${expected}x${expected}.`);
  }
}

// Every local script/stylesheet referenced by an HTML page must exist.
for (const htmlFile of walk('src').filter((file) => file.endsWith('.html'))) {
  const source = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8');
  for (const match of source.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:|data:|#)/i.test(target)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(htmlFile), target));
    if (!exists(resolved)) fail(`${htmlFile} references missing asset: ${target}`);
  }
}

if (errors.length) {
  console.error(`CleanVid check failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`  ✖ ${error}`);
  process.exitCode = 1;
} else {
  console.log('CleanVid check passed.');
  console.log(`  ${referenced ? referenced.size : 0} manifest files, ${jsFiles.length} JS files, 4 icons.`);
  for (const note of notes) console.log(`  · ${note}`);
}
