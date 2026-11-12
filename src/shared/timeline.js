/**
 * CleanVid — time ranges, chunk scheduling and transcript matching.
 *
 * Shared by the engine (coverage bookkeeping, choosing what to analyse next)
 * and the content script (matching transcripts against the word list and
 * merging audio and caption detections).
 *
 * Ranges are [start, end] pairs in seconds, kept sorted and merged.
 * Exposes CleanVid.Timeline.
 */
(() => {
  const NS = (globalThis.CleanVid = globalThis.CleanVid || {});
  if (NS.Timeline) return;

  const EPS = 0.05;

  function normalize(ranges, gap = EPS) {
    const sorted = (ranges || [])
      .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
      .map((r) => [r[0], r[1]])
      .sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const range of sorted) {
      const last = out[out.length - 1];
      if (last && range[0] <= last[1] + gap) last[1] = Math.max(last[1], range[1]);
      else out.push(range);
    }
    return out;
  }

  function add(ranges, range, gap = EPS) {
    return normalize([...(ranges || []), range], gap);
  }

  /** Parts of `ranges` not covered by `minus`. */
  function subtract(ranges, minus) {
    const cut = normalize(minus, 0);
    const out = [];
    for (const [start, end] of normalize(ranges, 0)) {
      let cursor = start;
      for (const [cs, ce] of cut) {
        if (ce <= cursor) continue;
        if (cs >= end) break;
        if (cs > cursor) out.push([cursor, Math.min(cs, end)]);
        cursor = Math.max(cursor, ce);
        if (cursor >= end) break;
      }
      if (cursor < end) out.push([cursor, end]);
    }
    return out.filter((r) => r[1] - r[0] > 0.01);
  }

  function intersect(a, b) {
    const left = normalize(a, 0);
    const right = normalize(b, 0);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      const start = Math.max(left[i][0], right[j][0]);
      const end = Math.min(left[i][1], right[j][1]);
      if (end > start) out.push([start, end]);
      if (left[i][1] < right[j][1]) i++;
      else j++;
    }
    return out;
  }

  function contains(ranges, time, tolerance = 0) {
    for (const [start, end] of ranges || []) {
      if (time >= start - tolerance && time <= end + tolerance) return true;
      if (start > time + tolerance) break;
    }
    return false;
  }

  function rangeAt(ranges, time, tolerance = 0) {
    for (const range of ranges || []) {
      if (time >= range[0] - tolerance && time <= range[1] + tolerance) return range;
    }
    return null;
  }

  function total(ranges) {
    return (ranges || []).reduce((sum, r) => sum + Math.max(0, r[1] - r[0]), 0);
  }

  /** Seconds of contiguous coverage from `time` forward (0 if not covered). */
  function aheadOf(ranges, time) {
    const range = rangeAt(ranges, time, 0.25);
    return range ? Math.max(0, range[1] - time) : 0;
  }

  /**
   * Choose the next analysis window.
   *
   * @param {object} p
   *   available: ranges of audio we hold
   *   coverage:  ranges already analysed
   *   playhead:  current playback time
   *   duration:  video duration (0 if unknown)
   *   maxChunk:  committed seconds per window (Whisper sees ≤ 30 s)
   *   context:   seconds of audio kept on each side for context
   *   waitedMs:  how long the scheduler has been idle (lets short tails run)
   * @returns {{start, end, commitEnd, audioStart, audioEnd, near}|null}
   */
  function nextWindow(p) {
    const maxChunk = p.maxChunk || 27;
    const context = p.context == null ? 1 : p.context;
    const duration = p.duration > 0 ? p.duration : Infinity;
    const playhead = Math.max(0, p.playhead || 0);
    const available = normalize(p.available, 0.12);
    const gaps = subtract(available, p.coverage || []).filter((g) => g[1] - g[0] >= 0.3);
    if (!gaps.length) return null;

    // 1) gap containing the playhead (start just before it), 2) next gaps
    // after the playhead in order, 3) earlier gaps, newest first.
    const ordered = [];
    for (const gap of gaps) {
      if (gap[0] <= playhead + 0.5 && gap[1] > playhead) {
        ordered.push({ gap, start: Math.max(gap[0], playhead - 0.75), rank: 0 });
      }
    }
    for (const gap of gaps) if (gap[0] > playhead + 0.5) ordered.push({ gap, start: gap[0], rank: 1 });
    const earlier = gaps.filter((gap) => gap[1] <= playhead).reverse();
    for (const gap of earlier) ordered.push({ gap, start: gap[0], rank: 2 });
    // Part of the playhead gap that lies before the playhead.
    for (const gap of gaps) {
      if (gap[0] < playhead - 0.75 && gap[1] > playhead) {
        ordered.push({ gap: [gap[0], playhead - 0.75], start: gap[0], rank: 2 });
      }
    }

    const covered = normalize(p.coverage || [], 0);
    for (const item of ordered) {
      const [gapStart, gapEnd] = item.gap;
      const start = item.start;
      const availableRange = rangeAt(available, start + 0.01) || [gapStart, gapEnd];
      const end = Math.min(gapEnd, start + maxChunk);
      const length = end - start;
      const hitsCoverage = contains(covered, end + 0.02) && end === gapEnd;
      const atVideoEnd = end >= duration - 0.25;
      const atAudioEdge = !hitsCoverage && !atVideoEnd && end >= availableRange[1] - 0.02;
      const near = start <= playhead + 45 && item.rank < 2;

      // Short tails that end where audio simply has not arrived yet are
      // better analysed once more audio is buffered — unless they are needed
      // now (near the playhead) or the scheduler has been idle a while.
      if (atAudioEdge && length < 12 && !near && (p.waitedMs || 0) < 8000) continue;
      if (length < 0.3) continue;

      // Leave the last second for the next window so no word is analysed
      // without trailing context, except at hard boundaries.
      let commitEnd = end;
      if (atAudioEdge || (!hitsCoverage && !atVideoEnd && end < gapEnd)) {
        commitEnd = length > 3 ? end - context : end;
        if (atAudioEdge && length <= 3 && !near && (p.waitedMs || 0) < 8000) continue;
      }
      return {
        start,
        end,
        commitEnd,
        audioStart: Math.max(availableRange[0], start - context),
        audioEnd: Math.min(availableRange[1], end + context),
        near,
        rank: item.rank,
      };
    }
    return null;
  }

  // --- Transcript matching --------------------------------------------------

  /**
   * Run the matcher over timed words.
   * @param matcher  CleanVid.Matcher index
   * @param words    [{t0, t1, text, conf}] sorted by t0
   * @returns occurrences [{start, end, entry, rule, text, source, conf}]
   */
  function matchWords(matcher, words, options = {}) {
    const source = options.source || 'audio';
    const maxGap = options.maxGap || 1.5;
    const out = [];
    if (!matcher || !Array.isArray(words) || !words.length) return out;

    let runStart = 0;
    const flush = (endIndex) => {
      if (endIndex <= runStart) return;
      let text = '';
      const offsets = [];
      for (let i = runStart; i < endIndex; i++) {
        if (text) text += ' ';
        offsets.push([text.length, text.length + String(words[i].text).length, i]);
        text += words[i].text;
      }
      const { matches } = matcher.analyze(text);
      for (const match of matches) {
        let first = -1;
        let last = -1;
        for (const [s, e, index] of offsets) {
          if (e > match.start && s < match.end) {
            if (first < 0) first = index;
            last = index;
          }
        }
        if (first < 0) continue;
        let conf = 1;
        for (let i = first; i <= last; i++) conf = Math.min(conf, Number(words[i].conf) || 0);
        out.push({
          start: words[first].t0,
          end: words[last].t1,
          entry: match.entry.raw,
          rule: match.rule,
          text: match.matchedText,
          source,
          conf,
        });
      }
    };
    for (let i = 1; i <= words.length; i++) {
      if (i === words.length || words[i].t0 - words[i - 1].t1 > maxGap) {
        flush(i);
        runStart = i;
      }
    }
    return out;
  }

  /**
   * Merge detections.
   *  - Whisper+aligner hits are authoritative and precisely timed.
   *  - Greedy CTC hits (no language model) add recall, but only for exact
   *    (non-fuzzy) matches with decent confidence and no Whisper hit nearby.
   *  - Caption hits are dropped where audio analysis already found the same
   *    moment (audio timing wins); elsewhere they are kept for recall.
   */
  function combine({ audio = [], ctc = [], captions = [], coverage = [] }) {
    const out = audio.map((item) => ({ ...item }));
    const near = (list, item, window) =>
      list.some((other) => other.start <= item.end + window && other.end >= item.start - window);

    for (const item of ctc) {
      if (item.rule === 'fuzzy') continue;
      if ((Number(item.conf) || 0) < 0.55) continue;
      if (String(item.entry || '').length < 3) continue;
      if (near(out, item, 0.4)) continue;
      out.push({ ...item, source: 'ctc' });
    }
    const audioHits = [...out];
    for (const item of captions) {
      const mid = (item.start + item.end) / 2;
      if (contains(coverage, mid, 0) && near(audioHits, item, 1.2)) continue;
      out.push({ ...item, source: item.source || 'captions' });
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }

  /** Replace the words inside [start, end) with `incoming` (sorted by t0). */
  function spliceWords(existing, incoming, start, end) {
    const kept = (existing || []).filter((word) => {
      const mid = (word.t0 + word.t1) / 2;
      return mid < start || mid >= end;
    });
    const merged = kept.concat(incoming || []);
    merged.sort((a, b) => a.t0 - b.t0);
    return merged;
  }

  NS.Timeline = {
    normalize,
    add,
    subtract,
    intersect,
    contains,
    rangeAt,
    total,
    aheadOf,
    nextWindow,
    matchWords,
    combine,
    spliceWords,
  };
})();
