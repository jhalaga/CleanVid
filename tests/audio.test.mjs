import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCleanVid } from './helpers/load.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', name));

const { Media, Align, Timeline, Matcher, constants } = loadCleanVid(
  'src/shared/constants.js',
  'src/shared/matching.js',
  'src/shared/media.js',
  'src/shared/align.js',
  'src/shared/timeline.js'
);

// --- Media ------------------------------------------------------------------

test('WebM parser extracts init and timed Opus clusters from YouTube appends', () => {
  const parser = Media.createParser('audio/webm; codecs="opus"');
  const init = fixture('opus-init.webm');
  const first = fixture('opus-cluster1.webm');
  const second = fixture('opus-cluster2.webm');

  const a = parser.push(init);
  assert.ok(a.init && a.init.length > 100, 'init segment rebuilt');
  assert.equal(parser.info.codec, 'A_OPUS');
  assert.equal(parser.info.sampleRate, 48000);

  // Arbitrary byte slices must still produce whole clusters.
  assert.equal(parser.push(first.subarray(0, 777)).units.length, 0);
  const b = parser.push(Buffer.concat([first.subarray(777), second.subarray(0, 9)]));
  assert.equal(b.units.length, 1);
  assert.equal(b.units[0].start, 0);
  assert.ok(Math.abs(b.units[0].duration - 10) < 0.001);
  assert.ok(b.units[0].exact);
  const c = parser.push(second.subarray(9));
  assert.equal(c.units.length, 1);
  assert.ok(Math.abs(c.units[0].start - 10.001) < 1e-6);
});

test('WebM parser resynchronises after garbage and applies timestampOffset', () => {
  const parser = Media.createParser('audio/webm; codecs="opus"');
  parser.push(fixture('opus-init.webm'));
  const result = parser.push(Buffer.concat([Buffer.from([9, 9, 9, 9, 9]), fixture('opus-cluster2.webm')]), 5);
  assert.equal(result.units.length, 1);
  assert.ok(Math.abs(result.units[0].start - 15.001) < 1e-6);
});

test('rebuilt WebM init uses an unknown-size Segment', () => {
  const parser = Media.createParser('audio/webm');
  const { init } = parser.push(fixture('opus-init.webm'));
  const hex = Buffer.from(init).toString('hex');
  assert.ok(hex.includes('1853806701ffffffffffffff'));
  assert.ok(!hex.includes('114d9b74'), 'SeekHead removed');
});

function box(type, ...payload) {
  const body = Buffer.concat(payload.map((p) => Buffer.from(p)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

test('MP4 parser reads tfdt/trun timing from fragmented AAC', () => {
  const mdhd = box('mdhd', Buffer.alloc(4), u32(0), u32(0), u32(44100), u32(0), Buffer.alloc(4));
  const moov = box('moov', box('trak', box('mdia', mdhd)), box('mvex', box('trex', Buffer.alloc(4), u32(1), u32(1), u32(1024), u32(0), u32(0))));
  const ftyp = box('ftyp', Buffer.from('dash'), u32(0));
  const tfhd = box('tfhd', Buffer.from([0, 0, 0, 0]), u32(1));
  const tfdt = box('tfdt', Buffer.from([0, 0, 0, 0]), u32(441000));
  const trun = box('trun', Buffer.from([0, 0, 0, 1]), u32(43), u32(0));
  const moof = box('moof', box('mfhd', Buffer.alloc(8)), box('traf', tfhd, tfdt, trun));
  const mdat = box('mdat', Buffer.alloc(100));

  const parser = Media.createParser('audio/mp4; codecs="mp4a.40.2"');
  const all = Buffer.concat([ftyp, moov, box('sidx', Buffer.alloc(20)), moof, mdat]);
  const first = parser.push(all.subarray(0, 50));
  assert.equal(first.units.length, 0);
  const rest = parser.push(all.subarray(50));
  assert.ok(parser.init);
  assert.equal(rest.units.length, 1);
  assert.ok(Math.abs(rest.units[0].start - 10) < 1e-9);
  assert.ok(Math.abs(rest.units[0].duration - (43 * 1024) / 44100) < 1e-9);
});

test('Opus TOC durations', () => {
  assert.equal(Media.opusPacketDuration(Uint8Array.of(0xfc)), 0.02); // CELT 20 ms, 1 frame
  assert.equal(Media.opusPacketDuration(Uint8Array.of(0xfd)), 0.04); // 2 frames
  assert.equal(Media.opusPacketDuration(Uint8Array.of(0xff, 3)), 0.06); // code 3, 3 frames
});

test('base64 round trip', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 251);
  assert.deepEqual(Media.bytesFromBase64(Media.base64FromBytes(bytes)), bytes);
});

// --- Align ------------------------------------------------------------------

function fakeEmissions(sequence, vocab = 32) {
  // sequence: array of vocab ids per frame (one-hot-ish probabilities)
  const frames = sequence.length;
  const logits = new Float32Array(frames * vocab);
  sequence.forEach((id, t) => {
    for (let v = 0; v < vocab; v++) logits[t * vocab + v] = v === id ? 8 : 0;
  });
  return { logp: Align.logSoftmax(logits, frames, vocab), frames, vocab };
}

const V = Align.DEFAULT_VOCAB;
function framesFor(text) {
  // "_" = blank frame, " " = separator frame, letters = that char
  return [...text].map((ch) => (ch === '_' ? 0 : ch === ' ' ? V['|'] : V[ch]));
}

test('spoken form normalises transcript words for the aligner', () => {
  assert.equal(Align.spokenForm('F***ing,'), 'F ING');
  assert.equal(Align.spokenForm("don't"), "DON'T");
  assert.equal(Align.spokenForm('42'), 'FORTY TWO');
  assert.equal(Align.spokenForm('café!'), 'CAFE');
  assert.deepEqual(Align.transcriptWords(' [Music] What the hell (laughs) ♪ '), ['What', 'the', 'hell']);
});

test('forced alignment places words on the right frames', () => {
  const seq = framesFor('____WHAT__ __THE_ ___HEL_L____');
  const { logp, frames, vocab } = fakeEmissions(seq);
  const words = Align.alignWords(logp, frames, vocab, ['What', 'the', 'hell'], { frameSec: 0.02, offset: 10 });
  assert.equal(words.length, 3);
  const at = (frame) => 10 + frame * 0.02;
  assert.ok(Math.abs(words[0].t0 - at(4)) < 1e-6, `what t0 ${words[0].t0}`);
  assert.ok(Math.abs(words[0].t1 - at(8)) < 1e-6);
  const hellStart = seq.indexOf(V.H, 15);
  assert.ok(Math.abs(words[2].t0 - at(hellStart)) < 1e-6);
  assert.ok(Math.abs(words[2].t1 - at(hellStart + 5)) < 1e-6);
  assert.ok(words[2].conf > 0.9);
});

test('forced alignment handles repeated letters and unalignable words', () => {
  const seq = framesFor('__HEL_LO___ ___');
  const { logp, frames, vocab } = fakeEmissions(seq);
  const words = Align.alignWords(logp, frames, vocab, ['hello', '!!!'], { frameSec: 0.02 });
  assert.ok(Math.abs(words[0].t0 - 0.04) < 1e-6);
  assert.ok(words[1].estimated);
  assert.ok(words[1].t0 >= words[0].t1);
});

test('forced alignment returns null when the transcript cannot fit', () => {
  const { logp, frames, vocab } = fakeEmissions(framesFor('AB'));
  assert.equal(Align.forcedAlign(logp, frames, vocab, [V.A, V.B, V.C]), null);
});

test('greedy CTC decode produces timed words', () => {
  const seq = framesFor('__SHH_IT__ __OK__');
  const { logp, frames, vocab } = fakeEmissions(seq);
  const words = Align.greedyWords(logp, frames, vocab, { frameSec: 0.02, offset: 1 });
  assert.deepEqual(words.map((w) => w.text), ['shit', 'ok']);
  assert.ok(Math.abs(words[0].t0 - 1.04) < 1e-6);
});

// --- Timeline -----------------------------------------------------------------

test('range helpers merge, subtract and measure', () => {
  assert.deepEqual(Timeline.normalize([[5, 6], [0, 2], [1.98, 3]]), [[0, 3], [5, 6]]);
  assert.deepEqual(Timeline.subtract([[0, 10]], [[2, 3], [5, 20]]), [[0, 2], [3, 5]]);
  assert.deepEqual(Timeline.intersect([[0, 5]], [[3, 8]]), [[3, 5]]);
  assert.equal(Timeline.total([[0, 2], [5, 6]]), 3);
  assert.equal(Timeline.aheadOf([[0, 30]], 10), 20);
});

test('scheduler starts at the playhead, then moves forward, then fills earlier gaps', () => {
  const base = { available: [[0, 120]], duration: 120, maxChunk: 27, context: 1 };
  const first = Timeline.nextWindow({ ...base, coverage: [], playhead: 40 });
  assert.ok(Math.abs(first.start - 39.25) < 1e-9);
  assert.ok(Math.abs(first.commitEnd - (first.start + 26)) < 1e-9);
  assert.ok(first.audioStart < first.start && first.audioEnd > first.end);

  const second = Timeline.nextWindow({ ...base, coverage: [[first.start, first.commitEnd]], playhead: 41 });
  assert.ok(Math.abs(second.start - first.commitEnd) < 1e-9, 'continues forward');

  const later = Timeline.nextWindow({ ...base, coverage: [[39.25, 120]], playhead: 50 });
  assert.equal(later.rank, 2, 'fills before the playhead last');
  assert.ok(later.start >= 0 && later.end <= 39.25);
});

test('scheduler waits for more audio for short far-ahead tails', () => {
  const win = Timeline.nextWindow({ available: [[0, 105]], coverage: [[0, 100]], playhead: 10, duration: 600 });
  assert.equal(win, null);
  const later = Timeline.nextWindow({ available: [[0, 105]], coverage: [[0, 100]], playhead: 10, duration: 600, waitedMs: 9000 });
  assert.ok(later && later.start === 100);
});

test('matchWords maps matcher hits to word times and combine merges sources', () => {
  const matcher = Matcher.buildIndex(constants.DEFAULT_WORDS, 'smart');
  const words = [
    { text: 'What', t0: 1.0, t1: 1.2, conf: 0.9 },
    { text: 'the', t0: 1.2, t1: 1.3, conf: 0.9 },
    { text: 'fuck,', t0: 1.32, t1: 1.61, conf: 0.8 },
    { text: 'mother', t0: 5.0, t1: 5.3, conf: 0.9 },
    { text: 'fucker', t0: 5.3, t1: 5.7, conf: 0.9 },
  ];
  const audio = Timeline.matchWords(matcher, words);
  assert.equal(audio.length, 2);
  assert.equal(audio[0].start, 1.32);
  assert.equal(audio[0].end, 1.61);
  assert.equal(audio[1].start, 5.0);
  assert.equal(audio[1].end, 5.7);

  const ctc = Timeline.matchWords(matcher, [
    { text: 'shit', t0: 9, t1: 9.3, conf: 0.8 },
    { text: 'fuck', t0: 1.3, t1: 1.6, conf: 0.9 },
  ], { source: 'ctc' });
  const captions = [
    { start: 1.0, end: 2.0, entry: 'fuck', rule: 'exact', text: 'fuck' },
    { start: 50, end: 51, entry: 'damn', rule: 'exact', text: 'damn' },
  ];
  const merged = Timeline.combine({ audio, ctc, captions, coverage: [[0, 30]] });
  assert.deepEqual(merged.map((m) => [m.start, m.source]), [
    [1.32, 'audio'],
    [5.0, 'audio'],
    [9, 'ctc'],
    [50, 'captions'],
  ]);
});

test('spliceWords replaces only the committed window', () => {
  const existing = [{ t0: 1, t1: 2, text: 'a' }, { t0: 5, t1: 6, text: 'b' }];
  const out = Timeline.spliceWords(existing, [{ t0: 5.1, t1: 5.5, text: 'c' }], 4, 10);
  assert.deepEqual(out.map((w) => w.text), ['a', 'c']);
});

test('alignment does not stretch a word over untranscribed speech', () => {
  // Audio says "HI THERE YOU", transcript only has "hi".
  const seq = framesFor('__HI__ __THERE__ __YOU____');
  const { logp, frames, vocab } = fakeEmissions(seq);
  const words = Align.alignWords(logp, frames, vocab, ['hi'], { frameSec: 0.02 });
  assert.ok(Math.abs(words[0].t0 - 0.04) < 1e-6);
  assert.ok(words[0].t1 <= 0.08 + 1e-6, `t1 ${words[0].t1} should stay on "HI"`);
});
