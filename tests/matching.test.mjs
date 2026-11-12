import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCleanVid } from './helpers/load.mjs';

const CleanVid = loadCleanVid('src/shared/constants.js', 'src/shared/matching.js');
const { constants, Matcher } = CleanVid;

const words = [...constants.DEFAULT_WORDS, 'son of a bitch', 'piece of shit'];
const engines = {
  strict: Matcher.buildIndex(words, 'strict'),
  smart: Matcher.buildIndex(words, 'smart'),
  aggressive: Matcher.buildIndex(words, 'aggressive'),
};

function roots(text, mode) {
  return engines[mode].analyze(text).matches.map((match) => match.entry.raw);
}

const cases = [
  // Censored and leetspeak spellings.
  ['a$$', 'smart', ['ass']],
  ['$hit', 'smart', ['shit']],
  ['shit!', 'smart', ['shit']],
  ['@ss', 'smart', ['ass']],
  ['f***k', 'smart', ['fuck']],
  ['sh***t', 'smart', ['shit']],
  ['b***h', 'smart', ['bitch']],
  ['sh1t', 'strict', ['shit']],
  ['sh!t', 'strict', ['shit']],
  ['a$$hole', 'strict', ['asshole']],
  ['c0ck', 'strict', ['cock']],
  ['b1tch', 'strict', ['bitch']],
  ['p*ssy', 'strict', ['pussy']],
  ['d!ck', 'strict', ['dick']],
  ['fuuuuucking', 'strict', ['fucking']],
  ['mother-fucking', 'strict', ['motherfucking']],

  // Split letter spellings and split compounds.
  ['f u c k i n g', 'smart', ['fucking']],
  ['f. u. c. k.', 'smart', ['fuck']],
  ['f-u-c-k', 'smart', ['fuck']],
  ['mother fucker', 'smart', ['motherfucker']],
  ['dumb ass', 'smart', ['dumbass']],
  ['fuck face', 'smart', ['fuckface']],
  ['bull shit', 'smart', ['bullshit']],
  ['son of a bitch', 'smart', ['son of a bitch']],
  ['piece of shit', 'smart', ['piece of shit']],

  // Apostrophes must not turn "he'll" into "hell".
  ["he'll", 'aggressive', []],
  ['he’ll', 'aggressive', []],
  ['hell', 'smart', ['hell']],

  // Important false-positive guards.
  ['batches', 'smart', []],
  ['britches', 'smart', []],
  ['bugger', 'smart', ['bugger']],
  ['burger', 'aggressive', []],
  ['shut', 'aggressive', []],
  ['shot', 'aggressive', []],
  ['where', 'aggressive', []],
  ['whole', 'aggressive', []],
  ['coming', 'smart', []],
  ['regard', 'smart', []],
  ['reward', 'smart', []],
  ['regarded', 'smart', []],
  ['sitting', 'smart', []],
  ['shifting', 'smart', []],
  ['shitting', 'smart', ['shitting']],
  ['shitty', 'smart', ['shitty']],
  ['class', 'aggressive', []],
  ['assess', 'aggressive', []],
  ['fast', 'aggressive', []],
  ['farting', 'smart', ['farting']],
  ['fasting', 'smart', []],
  ['jazz', 'aggressive', []],
  ['chick', 'aggressive', []],
  ['chink', 'aggressive', ['chink']],
  ['spice', 'aggressive', []],
  ['spic', 'aggressive', ['spic']],
  ['dike', 'aggressive', []],
  ['dyke', 'aggressive', ['dyke']],
  ['prices', 'aggressive', []],
  ['pricks', 'aggressive', ['pricks']],
  ['walkers', 'smart', []],
  ['wankers', 'smart', ['wankers']],
  ['wank', 'aggressive', ['wank']],
  ['twat', 'aggressive', ['twat']],
  ['come', 'aggressive', []],
  ['pussy', 'aggressive', ['pussy']],
  ['pushy', 'aggressive', []],
  ['slutty', 'aggressive', ['slutty']],
  ['trans', 'aggressive', []],
  ['tranny', 'aggressive', ['tranny']],
  ['horseshoe', 'smart', []],
  ['horseshit', 'smart', ['horseshit']],
  ['bull ship', 'smart', []],
  ['passes context', 'smart', []],
  ['passes context', 'aggressive', []],
  ['fucked-up', 'smart', ['fucked']],
  ['fishery', 'smart', []],
  ['fuk', 'smart', []],
  ['fuk', 'aggressive', ['fuck']],
  ['fuking', 'smart', ['fucking']],

  // Whole-token behaviour.
  ['The quick brown fox.', 'aggressive', []],
  ['fucks', 'strict', ['fucks']],
  ['motherfuckers', 'strict', ['motherfuckers']],
];

test('matcher catches profanity without obvious false positives', () => {
  for (const [text, mode, expected] of cases) {
    assert.deepEqual(
      roots(text, mode),
      expected,
      `[${mode}] ${JSON.stringify(text)}`
    );
  }
});

test('wildcard distance handles masks and typos', () => {
  assert.equal(Matcher.wildcardDistance('f***k', 'fuck'), 0);
  assert.equal(Matcher.wildcardDistance('sh***t', 'shit'), 0);
  assert.equal(Matcher.wildcardDistance('f*ck', 'fuck'), 0);
  assert.equal(Matcher.wildcardDistance('f**k', 'fuck'), 0);
  assert.equal(Matcher.wildcardDistance('fxck', 'fuck'), 1);
  assert.equal(Matcher.wildcardDistance('fuck', 'duck'), 1);
});

test('normalization folds leet, masks and stretched letters', () => {
  assert.equal(Matcher.normalizeToken('SH1T'), 'shit');
  assert.equal(Matcher.normalizeToken('a$$'), 'ass');
  assert.equal(Matcher.normalizeToken('fuuuuck'), 'fuck');
  assert.equal(Matcher.normalizeToken('f***k'), 'f***k');
  assert.equal(Matcher.normalizeToken("fuckin'"), 'fuckin');
});

test('matches carry usable source offsets', () => {
  const text = 'Oh f*ck, that dumb ass is a class act.';
  const { matches } = engines.smart.analyze(text);
  assert.deepEqual(
    matches.map((match) => text.slice(match.start, match.end)),
    ['f*ck', 'dumb ass']
  );
  assert.deepEqual(
    matches.map((match) => match.entry.raw),
    ['fuck', 'dumbass']
  );
});

test('multiple matches are resolved without overlap', () => {
  const { matches } = engines.smart.analyze('fuck shit bitch');
  assert.equal(matches.length, 3);
  for (let i = 1; i < matches.length; i++) {
    assert.ok(matches[i - 1].end <= matches[i].start);
  }
});
