/**
 * CleanVid — caption parsing and timing helpers.
 *
 * YouTube serves captions in several shapes:
 *   - JSON3  { events: [{ tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs }] }] }
 *   - XML    <transcript><text start="1.2" dur="3.4">...</text></transcript>
 *   - VTT    00:00:01.000 --> 00:00:04.000
 *
 * The parsers return a common cue shape:
 *   { start, end, text, segments: [{ textStart, textEnd, start, end }] | null }
 *
 * `textStart`/`textEnd` are character offsets into `text`, which lets the
 * matcher map a matched word back to an accurate time even when a caption
 * line contains several word-timed segments.
 */
(() => {
  const NS = (globalThis.CleanVid = globalThis.CleanVid || {});
  if (NS.Captions) return;

  const XML_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
  };

  function decodeXmlEntities(value) {
    return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
      const key = String(entity).toLowerCase();
      if (key[0] === '#') {
        const code =
          key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        if (Number.isFinite(code)) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return whole;
          }
        }
        return whole;
      }
      return Object.prototype.hasOwnProperty.call(XML_ENTITIES, key)
        ? XML_ENTITIES[key]
        : whole;
    });
  }

  function stripMarkup(value) {
    return String(value || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '');
  }

  function cleanText(value) {
    return decodeXmlEntities(stripMarkup(value))
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
      .replace(/[\t\f\v]+/g, ' ')
      .replace(/\s*\r?\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Parse "1:23", "1:23:45", "00:01:23.500" or "83.5" into seconds. */
  function parseTimestamp(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const text = String(value == null ? '' : value)
      .trim()
      .replace(',', '.');
    if (!text) return NaN;
    const parts = text.split(':');
    if (parts.length > 3) return NaN;
    let seconds = 0;
    for (const part of parts) {
      const number = Number(part);
      if (!Number.isFinite(number)) return NaN;
      seconds = seconds * 60 + number;
    }
    return seconds;
  }

  function readAttributes(source) {
    const attrs = {};
    const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = re.exec(String(source || '')))) {
      attrs[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    }
    return attrs;
  }

  /** Build a cue from one JSON3 event. */
  function jsonEventToCue(event) {
    if (!event || !Array.isArray(event.segs)) return null;
    const startMs = Number(event.tStartMs) || 0;
    const durationMs = Number(event.dDurationMs) || 0;
    const start = Math.max(0, startMs / 1000);
    let end = durationMs > 0 ? Math.max(start + 0.4, (startMs + durationMs) / 1000) : 0;

    const rawSegments = [];
    const parts = [];
    let cursor = 0;

    for (const rawSeg of event.segs) {
      let text = rawSeg && rawSeg.utf8 != null ? String(rawSeg.utf8) : '';
      if (!text) continue;
      text = text.replace(/\r?\n/g, ' ');
      const offsetSeconds = (Number(rawSeg.tOffsetMs) || 0) / 1000;
      rawSegments.push({
        textStart: cursor,
        textEnd: cursor + text.length,
        start: Math.max(start, start + offsetSeconds),
      });
      parts.push(text);
      cursor += text.length;
    }

    const text = parts.join('');
    if (!text.trim()) return null;
    if (!durationMs) end = Math.max(start + 1, start + Math.min(12, text.length / 16));

    // JSON3 may split a phrase into adjacent segments that all carry the same
    // start offset. Treat those as one timed block; otherwise each fragment
    // incorrectly stretches to the cue end and later words get muted together.
    const groups = [];
    for (const segment of rawSegments) {
      const previous = groups[groups.length - 1];
      if (previous && Math.abs(previous.start - segment.start) < 0.001) {
        previous.textEnd = segment.textEnd;
      } else {
        groups.push({ ...segment });
      }
    }

    const segments = groups.map((segment, index) => {
      const next = groups[index + 1];
      const segmentEnd = next
        ? Math.max(segment.start, Math.min(end, next.start))
        : end;
      return {
        ...segment,
        end: segmentEnd > segment.start ? segmentEnd : Math.min(end, segment.start + 0.2),
      };
    });
    for (const segment of segments) {
      if (!(segment.end > segment.start)) segment.end = segment.start + 0.2;
    }

    return { start, end, text, segments };
  }

  function parseJson3(input) {
    let data = input;
    if (typeof input === 'string') {
      try {
        data = JSON.parse(input);
      } catch {
        return [];
      }
    }
    const events = Array.isArray(data && data.events) ? data.events : [];
    const cues = [];

    for (const event of events) {
      const cue = jsonEventToCue(event);
      if (!cue) continue;
      const previous = cues[cues.length - 1];

      if (event.aAppend === 1 && previous) {
        const shift = previous.text.length;
        previous.text += cue.text;
        previous.end = Math.max(previous.end, cue.end);
        if (previous.segments && cue.segments) {
          for (const segment of cue.segments) {
            segment.textStart += shift;
            segment.textEnd += shift;
            previous.segments.push(segment);
          }
        } else {
          previous.segments = null;
        }
        continue;
      }

      if (
        previous &&
        cue.text.trim() === previous.text.trim() &&
        Math.abs(cue.start - previous.start) < 0.35
      ) {
        previous.end = Math.max(previous.end, cue.end);
        continue;
      }
      cues.push(cue);
    }

    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  function parseXml(input) {
    const source = String(input || '');
    const cues = [];
    const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = re.exec(source))) {
      const attrs = readAttributes(match[1]);
      let start = parseTimestamp(attrs.start);
      if (!Number.isFinite(start) && attrs.t != null) start = Number(attrs.t) / 1000;
      if (!Number.isFinite(start) || start < 0) continue;

      let duration = parseTimestamp(attrs.dur);
      if (!Number.isFinite(duration) && attrs.d != null) duration = Number(attrs.d) / 1000;
      if (!Number.isFinite(duration) || duration <= 0) duration = 2;

      const text = cleanText(match[2]);
      if (!text) continue;
      cues.push({
        start,
        end: start + Math.max(0.4, duration),
        text,
        segments: null,
      });
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  function parseVtt(input) {
    const lines = String(input || '')
      .replace(/^\ufeff/, '')
      .split(/\r?\n/);
    const cues = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('-->')) continue;
      const [from, rest] = line.split('-->');
      if (rest == null) continue;
      const start = parseTimestamp(from);
      const end = parseTimestamp(rest.trim().split(/\s+/)[0]);
      if (!Number.isFinite(start) || start < 0) continue;

      const textLines = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i += 1;
      }
      const text = cleanText(textLines.join(' '));
      if (!text) continue;
      cues.push({
        start,
        end: Math.max(start + 0.4, Number.isFinite(end) ? end : start + 2),
        text,
        segments: null,
      });
    }
    return cues;
  }

  function parseSrt(input) {
    const blocks = String(input || '')
      .replace(/^\ufeff/, '')
      .replace(/\r/g, '')
      .trim()
      .split(/\n\s*\n/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n');
      const timeIndex = lines.findIndex((line) => line.includes('-->'));
      if (timeIndex < 0) continue;
      const [from, rest] = lines[timeIndex].split('-->');
      if (rest == null) continue;
      const start = parseTimestamp(from.trim());
      const end = parseTimestamp(rest.trim().split(/\s+/)[0]);
      if (!Number.isFinite(start) || start < 0) continue;
      const text = cleanText(lines.slice(timeIndex + 1).join(' '));
      if (!text) continue;
      cues.push({
        start,
        end: Math.max(start + 0.4, Number.isFinite(end) ? end : start + 2),
        text,
        segments: null,
      });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  /** Parse any YouTube timedtext payload into cues. */
  function parseResponse(input) {
    if (!input) return [];
    const source = String(input).replace(/^\ufeff/, '').trim();
    if (!source) return [];
    if (source[0] === '{' || source[0] === '[') return parseJson3(source);
    if (/^WEBVTT/i.test(source)) return parseVtt(source);
    if (/^(?:\d+\s*\n)?\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/m.test(source)) {
      return parseSrt(source);
    }
    if (source[0] === '<') return parseXml(source);
    return [];
  }

  function languageMatches(code, preferred) {
    if (!code || !preferred) return false;
    const value = String(code).toLowerCase();
    const want = String(preferred).toLowerCase();
    return (
      value === want ||
      value.startsWith(`${want}-`) ||
      value.split('-')[0] === want
    );
  }

  function isEnglish(track) {
    return languageMatches(track && track.languageCode, 'en');
  }

  /**
   * Pick a caption track. Prefers a requested language, manual over ASR, and
   * English when the setting is "auto".
   */
  function pickTrack(tracks, preferred = 'auto') {
    const list = (Array.isArray(tracks) ? tracks : []).filter(
      (track) => track && track.baseUrl
    );
    if (!list.length) return null;

    const want = String(preferred || 'auto').toLowerCase();
    if (want !== 'auto') {
      const inLanguage = list.filter((track) =>
        languageMatches(track.languageCode, want)
      );
      if (inLanguage.length) {
        return inLanguage.find((track) => track.kind !== 'asr') || inLanguage[0];
      }
    }

    const manual = list.filter((track) => track.kind !== 'asr');
    const asr = list.filter((track) => track.kind === 'asr');
    return (
      manual.find(isEnglish) ||
      asr.find(isEnglish) ||
      manual[0] ||
      asr[0] ||
      list[0]
    );
  }

  /**
   * Return the selected track plus every English alternative. Scanning both
   * the manual and auto-generated English tracks helps when one track omits a
   * word that another track contains.
   */
  function scanTracks(tracks, preferred = 'auto') {
    const list = (Array.isArray(tracks) ? tracks : []).filter(
      (track) => track && track.baseUrl
    );
    const primary = pickTrack(list, preferred);
    if (!primary) return [];

    const english = list
      .filter(isEnglish)
      .sort((a, b) => Number(a.kind === 'asr') - Number(b.kind === 'asr'));
    const englishAlternates = [
      english.find((track) => track.kind !== 'asr'),
      english.find((track) => track.kind === 'asr'),
    ].filter(Boolean);
    const unique = [];
    for (const track of [primary, ...englishAlternates]) {
      if (!unique.some((item) => item.baseUrl === track.baseUrl)) unique.push(track);
    }
    return unique;
  }

  function trackLabel(track) {
    if (!track) return '';
    let name = track.name;
    if (name && typeof name === 'object') {
      name =
        name.simpleText ||
        (Array.isArray(name.runs) ? name.runs.map((run) => run.text).join('') : '');
    }
    if (!name) name = track.languageCode || 'Captions';
    const auto = track.kind === 'asr' && !/auto/i.test(name);
    return auto ? `${name} (auto)` : String(name);
  }

  function cueSegments(cue) {
    if (!cue) return null;
    if (Array.isArray(cue.segments) && cue.segments.length) return cue.segments;
    return null;
  }

  /** Time at a character boundary in a cue. `index` may equal text length. */
  function timeAtBoundary(cue, index) {
    if (!cue) return 0;
    const text = cue.text || '';
    const start = Number(cue.start) || 0;
    const end = Math.max(start, Number(cue.end) || start);

    if (index <= 0) return start;
    if (index >= text.length) return end;

    const segments = cueSegments(cue);
    if (segments) {
      for (const segment of segments) {
        const textEnd =
          segment.textEnd != null
            ? segment.textEnd
            : segment.textStart + (segment.text || '').length;
        if (index >= segment.textStart && index <= textEnd) {
          const length = Math.max(1, textEnd - segment.textStart);
          const fraction = (index - segment.textStart) / length;
          return (
            segment.start +
            fraction * Math.max(0, (Number(segment.end) || start) - segment.start)
          );
        }
      }
      const last = segments[segments.length - 1];
      return Number(last.end) || end;
    }

    const fraction = index / Math.max(1, text.length);
    return start + fraction * (end - start);
  }

  /** Map a match's character span to a start/end time in seconds. */
  function spanForMatch(cue, startIndex, endIndex) {
    const start = timeAtBoundary(cue, Math.max(0, startIndex));
    let end = timeAtBoundary(cue, Math.max(startIndex + 1, endIndex));
    if (!(end > start)) end = start + 0.3;
    return {
      start: Math.max(0, start),
      end: Math.max(start + 0.2, Math.min(end, start + 30)),
    };
  }

  NS.Captions = {
    parseResponse,
    parseJson3,
    parseXml,
    parseVtt,
    parseSrt,
    parseTimestamp,
    pickTrack,
    scanTracks,
    trackLabel,
    languageMatches,
    timeAtBoundary,
    spanForMatch,
    cleanText,
    decodeXmlEntities,
  };
})();
