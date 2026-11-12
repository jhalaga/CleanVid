import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCleanVid } from './helpers/load.mjs';

const CleanVid = loadCleanVid('src/shared/constants.js', 'src/shared/captions.js');
const { Captions } = CleanVid;

test('parses JSON3 with word-level offsets', () => {
  const payload = {
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [{ utf8: 'Hello ' }, { utf8: 'there', tOffsetMs: 500 }],
      },
      {
        tStartMs: 4000,
        dDurationMs: 1500,
        segs: [{ utf8: 'what the ' }, { utf8: 'fuck', tOffsetMs: 700 }],
      },
    ],
  };
  const cues = Captions.parseJson3(JSON.stringify(payload));
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello there');
  assert.deepEqual(
    cues[0].segments.map((segment) => [segment.start, segment.end]),
    [
      [1, 1.5],
      [1.5, 3],
    ]
  );
  assert.equal(cues[0].text.length, 11);
  assert.equal(Captions.timeAtBoundary(cues[0], 6), 1.5);
  assert.equal(Captions.timeAtBoundary(cues[0], 11), 3);

  const match = cues[1].text.indexOf('fuck');
  const span = Captions.spanForMatch(cues[1], match, match + 4);
  assert.ok(Math.abs(span.start - 4.7) < 0.001, `start ${span.start}`);
  assert.ok(Math.abs(span.end - 5.5) < 0.001, `end ${span.end}`);
});

test('appends live JSON3 events and drops exact duplicates', () => {
  const cues = Captions.parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello ' }] },
      { tStartMs: 800, dDurationMs: 1200, aAppend: 1, segs: [{ utf8: 'world' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'next line' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'next line' }] },
    ],
  });
  assert.deepEqual(
    cues.map((cue) => cue.text),
    ['hello world', 'next line']
  );
});

test('coalesces JSON3 segments with equal offsets before estimating word times', () => {
  const cues = Captions.parseJson3({
    events: [
      {
        tStartMs: 10000,
        dDurationMs: 6000,
        segs: [
          { utf8: 'Damn, ' },
          { utf8: 'low angle, this PewDiePie feels like', tOffsetMs: 0 },
          { utf8: 'fucked-up', tOffsetMs: 4000 },
        ],
      },
    ],
  });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].segments.length, 2);
  assert.deepEqual(
    cues[0].segments.map(({ textStart, textEnd, start, end }) => [textStart, textEnd, start, end]),
    [
      [0, 42, 10, 14],
      [42, 51, 14, 16],
    ]
  );
  const damnStart = cues[0].text.indexOf('Damn');
  const damnSpan = Captions.spanForMatch(cues[0], damnStart, damnStart + 4);
  assert.ok(damnSpan.start >= 10 && damnSpan.start < 10.5);
  assert.ok(damnSpan.end < 11);
  const laterStart = cues[0].text.indexOf('fucked');
  const laterSpan = Captions.spanForMatch(cues[0], laterStart, laterStart + 6);
  assert.ok(laterSpan.start >= 14);
});

test('parses timedtext XML with entities and formatting tags', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <transcript>
      <text start="1.25" dur="2.5">Hello &amp; <i>welcome</i></text>
      <text start="4" dur="3">Don&#39;t <c.colorE5E5E5>stop</c.colorE5E5E5><br/>please</text>
    </transcript>`;
  const cues = Captions.parseXml(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.25);
  assert.equal(cues[0].end, 3.75);
  assert.equal(cues[0].text, 'Hello & welcome');
  assert.equal(cues[1].text, "Don't stop please");
});

test('parses VTT', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello <b>there</b>

01:02.500 --> 01:04.000 line:0
What the fuck
`;
  const cues = Captions.parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello there');
  assert.equal(cues[1].start, 62.5);
  assert.equal(cues[1].end, 64);
});

test('parses SRT subtitles', () => {
  const srt = `1\n00:00:01,000 --> 00:00:02,500\nWhat the damn\n\n2\n00:00:03,000 --> 00:00:04,000\nFucked-up!`;
  const cues = Captions.parseResponse(srt);
  assert.deepEqual(cues.map(({ start, end, text }) => [start, end, text]), [
    [1, 2.5, 'What the damn'],
    [3, 4, 'Fucked-up!'],
  ]);
});

test('parseResponse auto-detects formats and rejects junk', () => {
  assert.equal(Captions.parseResponse('').length, 0);
  assert.equal(Captions.parseResponse('not captions').length, 0);
  assert.equal(Captions.parseResponse('{"events":[]}').length, 0);
  assert.equal(Captions.parseResponse('<transcript></transcript>').length, 0);
  assert.equal(
    Captions.parseResponse(
      '<transcript><text start="0" dur="1">hi</text></transcript>'
    ).length,
    1
  );
});

test('parseTimestamp handles transcript labels', () => {
  assert.equal(Captions.parseTimestamp('1:23'), 83);
  assert.equal(Captions.parseTimestamp('1:02:03'), 3723);
  assert.equal(Captions.parseTimestamp('00:01:23.500'), 83.5);
  assert.equal(Captions.parseTimestamp('83.25'), 83.25);
  assert.ok(Number.isNaN(Captions.parseTimestamp('nope')));
});

test('pickTrack prefers requested language and manual tracks', () => {
  const tracks = [
    { languageCode: 'en', kind: 'asr', baseUrl: 'https://x/1' },
    { languageCode: 'en', kind: '', baseUrl: 'https://x/2' },
    { languageCode: 'es', kind: '', baseUrl: 'https://x/3' },
  ];
  assert.equal(Captions.pickTrack(tracks, 'auto').baseUrl, 'https://x/2');
  assert.equal(Captions.pickTrack(tracks, 'es').baseUrl, 'https://x/3');
  assert.equal(Captions.pickTrack(tracks, 'en').baseUrl, 'https://x/2');
  assert.equal(
    Captions.pickTrack([{ languageCode: 'de', kind: 'asr', baseUrl: 'https://x/4' }], 'fr')
      .baseUrl,
    'https://x/4'
  );
  assert.equal(Captions.pickTrack([], 'auto'), null);
});

test('scanTracks includes the preferred track and alternate English tracks once', () => {
  const manual = { languageCode: 'en', kind: '', baseUrl: 'https://x/manual' };
  const automatic = { languageCode: 'en', kind: 'asr', baseUrl: 'https://x/auto' };
  const spanish = { languageCode: 'es', kind: '', baseUrl: 'https://x/es' };
  assert.deepEqual(Captions.scanTracks([automatic, manual, spanish]), [manual, automatic]);
  assert.deepEqual(Captions.scanTracks([automatic, spanish], 'es'), [spanish, automatic]);
  assert.deepEqual(Captions.scanTracks([], 'auto'), []);
});

test('trackLabel describes auto-generated captions', () => {
  assert.equal(
    Captions.trackLabel({ languageCode: 'en', name: { simpleText: 'English' } }),
    'English'
  );
  assert.equal(
    Captions.trackLabel({ languageCode: 'en', kind: 'asr', name: { simpleText: 'English' } }),
    'English (auto)'
  );
  assert.equal(
    Captions.trackLabel({ languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } }),
    'English (auto-generated)'
  );
});
