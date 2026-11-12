/**
 * CleanVid — CTC alignment for wav2vec2 character models.
 *
 * Whisper tells us *what* was said; wav2vec2 (a CTC model with a character
 * vocabulary and ~20 ms frames) tells us *exactly when*. Given the per-frame
 * log-probabilities from wav2vec2 and Whisper's transcript, a Viterbi pass over
 * the CTC state graph assigns every character to frames, which yields precise
 * word start/end times. The same emissions are also decoded greedily as an
 * independent, language-model-free transcript that never "softens" swearing.
 *
 * Exposes CleanVid.Align. Pure JavaScript; tested in Node.
 */
(() => {
  const NS = (globalThis.CleanVid = globalThis.CleanVid || {});
  if (NS.Align) return;

  // facebook/wav2vec2-base-960h (Xenova ONNX export) vocabulary.
  const DEFAULT_VOCAB = Object.freeze({
    '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '|': 4,
    E: 5, T: 6, A: 7, O: 8, N: 9, I: 10, H: 11, S: 12, R: 13, D: 14, L: 15,
    U: 16, M: 17, W: 18, C: 19, F: 20, G: 21, Y: 22, P: 23, B: 24, V: 25,
    K: 26, "'": 27, X: 28, J: 29, Q: 30, Z: 31,
  });
  const BLANK = 0;
  const SEPARATOR = 4;

  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  function numberWords(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 20) return ONES[n];
    if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
    if (n < 1000) {
      return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
    }
    if (n < 1000000) {
      return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
    }
    return String(n).split('').map((digit) => ONES[Number(digit)]).join(' ');
  }

  /** Spoken-form letters for one transcript word, e.g. "5," → "FIVE", "don't" → "DON'T". */
  function spokenForm(word) {
    let value = String(word || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[‘’ʼ]/g, "'");
    value = value.replace(/\d+/g, (digits) => ` ${numberWords(digits)} `);
    value = value.replace(/&/g, ' and ').replace(/%/g, ' percent ');
    value = value.toUpperCase().replace(/[^A-Z' ]+/g, ' ');
    value = value.replace(/(^|\s)'+|'+(?=\s|$)/g, ' ');
    return value.replace(/\s+/g, ' ').trim();
  }

  /** Split a Whisper transcript into display words; drops [Music]/(laughs) tags. */
  function transcriptWords(text) {
    const cleaned = String(text || '')
      .replace(/\[[^\]]*\]|\([^)]*\)|♪+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return [];
    return cleaned.split(' ').filter((word) => /[\p{L}\p{N}*]/u.test(word));
  }

  /** Row-wise log-softmax of a [T, V] logits matrix, in place into a new array. */
  function logSoftmax(logits, frames, vocab) {
    const out = new Float32Array(frames * vocab);
    for (let t = 0; t < frames; t++) {
      const base = t * vocab;
      let max = -Infinity;
      for (let v = 0; v < vocab; v++) if (logits[base + v] > max) max = logits[base + v];
      let sum = 0;
      for (let v = 0; v < vocab; v++) sum += Math.exp(logits[base + v] - max);
      const log = max + Math.log(sum);
      for (let v = 0; v < vocab; v++) out[base + v] = logits[base + v] - log;
    }
    return out;
  }

  /**
   * Viterbi CTC forced alignment.
   * @returns per-token {first, last, score} frame spans, or null if the
   *          transcript cannot fit in the available frames.
   */
  function forcedAlign(logp, frames, vocab, tokens, blank = BLANK) {
    const L = tokens.length;
    if (!L) return [];
    const S = 2 * L + 1;
    let minFrames = L;
    for (let i = 1; i < L; i++) if (tokens[i] === tokens[i - 1]) minFrames += 1;
    if (frames < minFrames) return null;

    const label = new Int32Array(S);
    for (let s = 0; s < S; s++) label[s] = s % 2 === 0 ? blank : tokens[(s - 1) >> 1];
    const canSkip = new Uint8Array(S);
    for (let s = 2; s < S; s++) {
      if (s % 2 === 1 && label[s] !== label[s - 2]) canSkip[s] = 1;
    }

    const NEG = -1e30;
    let prev = new Float64Array(S).fill(NEG);
    let curr = new Float64Array(S);
    const back = new Uint8Array(frames * S); // 0 stay, 1 from s-1, 2 from s-2

    prev[0] = logp[blank];
    prev[1] = logp[label[1]];
    for (let t = 1; t < frames; t++) {
      const base = t * vocab;
      // Only states that can still reach the end are useful; keep it simple
      // and bound by what is reachable from the start.
      const maxState = Math.min(S - 1, 2 * t + 1);
      const minState = Math.max(0, S - 2 * (frames - t));
      for (let s = 0; s < S; s++) {
        if (s > maxState || s < minState) {
          curr[s] = NEG;
          continue;
        }
        let best = prev[s];
        let from = 0;
        if (s >= 1 && prev[s - 1] > best) {
          best = prev[s - 1];
          from = 1;
        }
        if (canSkip[s] && prev[s - 2] > best) {
          best = prev[s - 2];
          from = 2;
        }
        curr[s] = best + logp[base + label[s]];
        back[t * S + s] = from;
      }
      const swap = prev;
      prev = curr;
      curr = swap;
    }

    let state = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
    if (prev[state] <= NEG / 2) return null;
    const path = new Int32Array(frames);
    for (let t = frames - 1; t >= 0; t--) {
      path[t] = state;
      if (t > 0) state -= back[t * S + state];
    }

    const spans = Array.from({ length: L }, () => ({
      first: -1,
      last: -1,
      score: -Infinity,
      peakFirst: -1,
      peakLast: -1,
      bestFrame: -1,
    }));
    for (let t = 0; t < frames; t++) {
      const s = path[t];
      if (s % 2 === 0) continue;
      const k = (s - 1) >> 1;
      const span = spans[k];
      if (span.first < 0) span.first = t;
      span.last = t;
      const value = logp[t * vocab + label[s]];
      if (value > span.score) {
        span.score = value;
        span.bestFrame = t;
      }
      // Frames where the model actually hears this character. When the
      // transcript is missing words, Viterbi parks the path on a neighbouring
      // character for many frames of unrelated speech; those frames have very
      // low probability for that character and must not stretch the word.
      if (value >= PEAK_LOGP) {
        if (span.peakFirst < 0) span.peakFirst = t;
        span.peakLast = t;
      }
    }
    for (const span of spans) {
      if (span.first < 0) continue;
      if (span.peakFirst < 0) {
        span.peakFirst = span.bestFrame;
        span.peakLast = span.bestFrame;
      }
      span.rawFirst = span.first;
      span.rawLast = span.last;
      span.first = span.peakFirst;
      span.last = span.peakLast;
    }
    return spans;
  }

  const PEAK_LOGP = Math.log(0.02);

  /**
   * Align transcript words to audio.
   * @param {Float32Array} logp  log-probabilities [frames * vocab]
   * @param {string[]} words     display words (Whisper tokens)
   * @param {object} options     { frameSec, offset, vocab }
   * @returns [{ text, t0, t1, conf }] in seconds (offset added)
   */
  function alignWords(logp, frames, vocabSize, words, options = {}) {
    const vocabMap = options.vocab || DEFAULT_VOCAB;
    const frameSec = options.frameSec || 0.02;
    const offset = options.offset || 0;
    const tokens = [];
    const owners = []; // token index -> word index
    const spoken = words.map(spokenForm);

    let first = true;
    for (let w = 0; w < words.length; w++) {
      const letters = spoken[w].replace(/ /g, '|');
      if (!letters) continue;
      if (!first) {
        tokens.push(vocabMap['|'] ?? SEPARATOR);
        owners.push(-1);
      }
      first = false;
      for (const ch of letters) {
        const id = vocabMap[ch];
        if (id == null) continue;
        tokens.push(id);
        owners.push(ch === '|' ? -1 : w);
      }
    }

    const result = words.map((text) => ({ text, t0: NaN, t1: NaN, conf: 0 }));
    const spans = tokens.length ? forcedAlign(logp, frames, vocabSize, tokens) : [];
    if (spans && spans.length) {
      const scores = words.map(() => []);
      for (let k = 0; k < spans.length; k++) {
        const w = owners[k];
        if (w < 0 || spans[k].first < 0) continue;
        const span = spans[k];
        const t0 = offset + span.first * frameSec;
        const t1 = offset + (span.last + 1) * frameSec;
        const item = result[w];
        if (!(item.t0 <= t0)) item.t0 = t0;
        if (!(item.t1 >= t1)) item.t1 = t1;
        scores[w].push(span.score);
      }
      for (let w = 0; w < words.length; w++) {
        if (scores[w].length) {
          const mean = scores[w].reduce((a, b) => a + b, 0) / scores[w].length;
          result[w].conf = Math.round(Math.exp(mean) * 1000) / 1000;
        }
      }
    }
    fillGaps(result, offset, offset + frames * frameSec);
    return result;
  }

  /** Words that could not be aligned get times interpolated from neighbours. */
  function fillGaps(items, start, end) {
    for (let i = 0; i < items.length; i++) {
      if (Number.isFinite(items[i].t0)) continue;
      let j = i;
      while (j < items.length && !Number.isFinite(items[j].t0)) j++;
      const left = i > 0 ? items[i - 1].t1 : start;
      const right = j < items.length ? items[j].t0 : end;
      const count = j - i;
      const step = Math.max(0, right - left) / count;
      for (let k = 0; k < count; k++) {
        items[i + k].t0 = left + step * k;
        items[i + k].t1 = left + step * (k + 1);
        items[i + k].conf = 0;
        items[i + k].estimated = true;
      }
      i = j - 1;
    }
  }

  /** Greedy CTC decode into timed words. */
  function greedyWords(logp, frames, vocabSize, options = {}) {
    const vocabMap = options.vocab || DEFAULT_VOCAB;
    const frameSec = options.frameSec || 0.02;
    const offset = options.offset || 0;
    const idToChar = [];
    for (const [key, id] of Object.entries(vocabMap)) idToChar[id] = key;
    const separator = vocabMap['|'] ?? SEPARATOR;

    const words = [];
    let current = null;
    let previous = -1;
    for (let t = 0; t < frames; t++) {
      const base = t * vocabSize;
      let best = 0;
      let bestValue = logp[base];
      for (let v = 1; v < vocabSize; v++) {
        if (logp[base + v] > bestValue) {
          bestValue = logp[base + v];
          best = v;
        }
      }
      if (best !== previous) {
        if (best === separator) {
          if (current) words.push(current);
          current = null;
        } else if (best !== BLANK) {
          const ch = idToChar[best];
          if (ch && ch.length === 1) {
            if (!current) current = { text: '', t0: offset + t * frameSec, t1: 0, scores: [] };
            current.text += ch;
            current.scores.push(bestValue);
          }
        }
      }
      if (current && best !== BLANK && best !== separator) {
        current.t1 = offset + (t + 1) * frameSec;
      }
      previous = best;
    }
    if (current) words.push(current);
    return words
      .filter((word) => word.text.replace(/'/g, '').length > 0)
      .map((word) => ({
        text: word.text.toLowerCase(),
        t0: word.t0,
        t1: Math.max(word.t1, word.t0 + frameSec),
        conf:
          Math.round(Math.exp(word.scores.reduce((a, b) => a + b, 0) / word.scores.length) * 1000) /
          1000,
      }));
  }

  NS.Align = {
    DEFAULT_VOCAB,
    BLANK,
    spokenForm,
    numberWords,
    transcriptWords,
    logSoftmax,
    forcedAlign,
    alignWords,
    greedyWords,
  };
})();
