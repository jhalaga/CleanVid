/**
 * CleanVid — profanity matcher.
 *
 * Goals:
 *  - Whole-token matching, so "ass" never matches "class" or "assume".
 *  - Catch real-world caption spellings: censored (f*ck, a$$), leetspeak
 *    (sh1t), stretched (fuuuck), hyphenated (mother-fucker), split across
 *    tokens ("mother fucker") and spelled out ("f u c k").
 *  - Keep fuzzy tolerance conservative by default to avoid muting innocent
 *    words. "Smart" only fuzzes words 6+ characters and requires the same
 *    first letter; a guard list blocks the common look-alikes.
 *
 * Exposes CleanVid.Matcher.
 */
(() => {
  const NS = (globalThis.CleanVid = globalThis.CleanVid || {});
  if (NS.Matcher) return;

  const MASK_CHARS = new Set(['*', '#', '•', '·', '＊', '✱']);
  const MASK_CLASS = '*#•·＊✱';
  // Apostrophes deliberately split tokens: "he'll" must not normalize to
  // "hell". Trailing apostrophes ("fuckin'") are excluded by construction.
  const TOKEN_RE = new RegExp(
    `[${MASK_CLASS}]*[\\p{L}\\p{N}${MASK_CLASS}]+(?:(?:[_\\-!@$])+[\\p{L}\\p{N}${MASK_CLASS}]+)*`,
    'gu'
  );
  const EDGE_RE = new RegExp(
    `(?<![\\p{L}\\p{N}])([!@$]*)([\\p{L}\\p{N}${MASK_CLASS}]+(?:(?:[_\\-!@$])+[\\p{L}\\p{N}${MASK_CLASS}]+)*)([!@$]*)(?![\\p{L}\\p{N}])`,
    'gu'
  );

  const LEET = new Map([
    ['0', 'o'],
    ['1', 'i'],
    ['3', 'e'],
    ['4', 'a'],
    ['5', 's'],
    ['6', 'g'],
    ['7', 't'],
    ['8', 'b'],
    ['9', 'g'],
    ['@', 'a'],
    ['$', 's'],
    ['!', 'i'],
    ['|', 'l'],
    ['+', 't'],
  ]);

  const EXTRA_FOLD = new Map([
    ['ß', 'ss'],
    ['ø', 'o'],
    ['ł', 'l'],
    ['đ', 'd'],
    ['ð', 'd'],
    ['þ', 'th'],
    ['æ', 'ae'],
    ['œ', 'oe'],
    ['ı', 'i'],
  ]);

  // Common innocent words that are one edit away from profanity. These only
  // block fuzzy (approximate) matches; exact matches always win.
  const ALLOW_WORDS = new Set(
    `
    a an and are as at be been before being below between both but by can could did
    do does doing done down during each few for from further get got had has have
    having he her here hers herself him himself his how i if in into is it its
    itself just know like me more most my myself no nor not now of off on once only
    or other our ours ourselves out over own same she should so some such than that
    the their theirs them themselves then there these they this those through to too
    under until up very was we were what when where which while who whom why will
    with would you your yours yourself yourselves

    about above across after again against all almost alone along already also
    although always among another any anyone anything around away back bad bag bags
    bank banker bars bass bastion batch batches beach because become becomes bed
    been before began begin behind best better between beyond big bigger bike bikes
    bill bit bits bitter blood blue board boat body book born boss both box boy
    break bring brother brought build built bus busy call came camp cap car card
    care carry case cat catch cause cell cent chair chance change check chick child
    children choice choose church city class clean clear clock close coach coast
    coat code cold come coming cook cool copy cork corner cost could count country
    course court cover cross crowd cut cuts dance dark data date daughter day dead
    deal dear death deep did die different difficult dinner do dock docks does dog
    door double down draw dream dress drink drive drop dry duck ducks due each ear
    early earth east easy eat edge education effect egg eight either else end enjoy
    enough enter even evening ever every everyone everything exactly example eye
    face fact fail fair fall family far farm fast fat father fault fear feel feet
    fell felt few field fight figure fill film final find fine finger finish fire
    first fish fit fits five flat floor fly focus folk follow food foot force fork
    form forward found four free friend from front full fun fund future game garden
    gas gave general get girl give glad glass go goal god gold gone good got
    government great green grew ground group grow guess gun guy had hair half hand
    hang happen happy hard has hat hate have he head hear heard heart heat heavy
    held hell hello help her here high hill him himself his history hit hits hold
    hole home hope horse hospital hot hotel hour house how however huge human
    hundred hung hunt hurry hurt husband idea if image imagine impact important in
    include including increase indeed industry information inside instead interest
    into investment involve issue it item its itself job join just keep key kid
    kill kind king kitchen knew know knowledge land language large last late later
    laugh law lay lead leader learn least leave left leg less let letter level lie
    life light like likely line list listen little live local long look lose loss
    lost lot love low luck lunch machine made main maintain major make man manage
    manager many map market marriage material matter may maybe me mean measure
    media meet meeting member memory mention message method middle might military
    million mind minute miss mission model modern moment money month more morning
    most mother mouth move movie much music must my myself name nation national
    natural nature near nearly necessary need network never new news next nice
    night no none nor north nose not note nothing notice now number occur of off
    offer office officer official often oh oil ok old on once one only open
    operation opportunity option or order organization other others our out outside
    over own owner page pain painting paper parent part particular partner party
    pass passes passers past patient pattern pay peace people per perform perhaps period person
    phone pick picture piece place plan plant play player point police policy
    political poor popular population position possible power practice prepare
    present president pressure pretty prevent price pricy pride prime print prints
    private probably problem process produce product program project property
    protect prove provide public pull purpose push put quality question quickly
    quiet quite race radio raise range rate rather reach read ready real reality
    realize really reason receive recent recognize record red reduce reflect region
    regard regarding regards regular relate relationship religious remain remember
    remove report represent require research resource respond response rest result
    return reveal revenue review rich right rise risk road rock role room rule run
    safe same save say scene school science score sea season seat second section
    security see seek seem sell send sense sent series serious serve service set
    settle seven several shake share she shoot shop short shot shots should show
    side sign significant similar simple simply since sing single sister sit site
    situation six size skill skin small smile so social society soft soldier some
    somebody someone something sometimes son song soon sort sound source south
    southern space speak special specific speech spend sport spring staff stage
    stand standard start state station stay step still stock stop store storm story
    strategy street strong structure student study stuff style subject success
    such suddenly suffer suggest summer support sure surface system table take talk
    task tax teach teacher team technology tell ten tend term test than thank thanks
    that the their them themselves then theory there these they thing think third
    this those though thought thousand threat three through throughout throw thus
    time tiny tired to today together tonight too top total tough toward town trade
    traditional training travel treat treatment tree trial trip trouble true truth
    try turn twice two type under understand unit until up upon us use usually
    value various very victim view violence visit voice wait walk wall want war
    watch water way we weapon wear week weight well went were west western what
    whatever when where whether which while white who whole whom whose why wide
    wife will win wind window wish with within without woman wonder word work worker
    world worry would write wrong yard yeah year yes yesterday yet you young your
    yourself

    assess assets ashes bagger baggers bigger biggers botches britches bugged
    bugler buglers buggers bullocks bullshot bullshots burger burgers bustard
    bustards carp chick chock chocks chunk clock clocks cook cooks cork corks
    coming counts cramp crampy crock crocks cunning dam dame dammed damp darn dawn
    deck deckhead decks dices dike dikes disk disks dock docks duck ducks duke dye
    facts faked fakers faking farm farms fast fasted fasts fat farted fasting fits
    fort forts funk funks hall held help hello hill horseshoe horseshoes hull hunt
    jazz kids kiss kisser kisses kit kits pick picks pike pining pinning pish pits
    pitting prices pricy prints prizes puss pusses pushy regard regarded regards
    reward rewarded rewards shifty shimmy shinty shirting shirts shirty shifting
    sitting slitting slots slits spec spice spin spit spitting sultry that thats
    think trans trance twas walker walkers walking walked walks wander wanders
    wand wands want wanted wanting wants waker wakers waking wheres whole wink
    winked winker winkers winking winks wonk wanks wore wits ties shut shuts
    `
      .split(/\s+/)
      .filter(Boolean)
  );

  function foldUnicode(value) {
    let out = '';
    for (const ch of value) {
      const folded = EXTRA_FOLD.get(ch);
      out += folded !== undefined ? folded : ch;
    }
    return out;
  }

  function normalizeToken(raw) {
    if (!raw) return '';
    let value = foldUnicode(String(raw).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
    value = value.toLowerCase();
    let out = '';
    for (const ch of value) {
      if (MASK_CHARS.has(ch)) {
        out += ch;
      } else if (LEET.has(ch)) {
        out += LEET.get(ch);
      } else if (/['’_\-\s]/u.test(ch)) {
        // joiners are removed
      } else if (/[\p{L}\p{N}]/u.test(ch)) {
        out += ch;
      }
    }
    // "fuuuuck" → "fuck"; double letters such as "ass" are preserved, and
    // mask runs must stay intact so "f***k" can stand in for "fuck".
    out = out.replace(/(\p{L})\1{2,}/gu, '$1');
    return out;
  }

  function hasMask(value) {
    for (const ch of value) if (MASK_CHARS.has(ch)) return true;
    return false;
  }

  function maxDistanceFor(length, sensitivity) {
    if (sensitivity === 'strict') return 0;
    if (sensitivity === 'smart') {
      if (length >= 9) return 2;
      if (length >= 6) return 1;
      return 0;
    }
    // aggressive
    if (length >= 7) return 2;
    if (length >= 4) return 1;
    return 0;
  }

  /** Levenshtein distance where a mask on either side matches any character
   *  and can also stand for zero characters ("f***k" → "fuck"). */
  function wildcardDistance(a, b, max = 64) {
    const n = a.length;
    const m = b.length;
    if (Math.abs(n - m) > max) return max + 1;
    let prev = new Array(m + 1);
    let curr = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      const aCh = a[i - 1];
      const aMask = MASK_CHARS.has(aCh);
      curr[0] = aMask ? prev[0] : prev[0] + 1;
      let rowMin = curr[0];
      for (let j = 1; j <= m; j++) {
        const bCh = b[j - 1];
        const bMask = MASK_CHARS.has(bCh);
        const match = aMask || bMask || aCh === bCh;
        const deleteCost = aMask ? 0 : 1;
        const insertCost = bMask ? 0 : 1;
        let value = Math.min(
          prev[j] + deleteCost,
          curr[j - 1] + insertCost,
          prev[j - 1] + (match ? 0 : 1)
        );
        curr[j] = value;
        if (value < rowMin) rowMin = value;
      }
      if (rowMin > max) return max + 1;
      [prev, curr] = [curr, prev];
    }
    return prev[m];
  }

  function tokenize(text) {
    const tokens = [];
    if (!text) return tokens;
    TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = TOKEN_RE.exec(text))) {
      const raw = match[0];
      const norm = normalizeToken(raw);
      if (!norm || !/[\p{L}]/u.test(norm)) continue;
      tokens.push({
        raw,
        norm,
        start: match.index,
        end: match.index + raw.length,
        masked: hasMask(norm),
      });
    }
    return tokens;
  }

  function entryKey(tokens) {
    return tokens.map((t) => t.norm).join('\u0001');
  }

  function buildEntry(raw) {
    const cleaned = String(raw || '').trim();
    if (!cleaned) return null;
    let tokens = tokenize(cleaned);
    if (!tokens.length) return null;
    // "f u c k" / "f.u.c.k" should become one entry.
    if (tokens.length >= 3 && tokens.every((t) => t.norm.length === 1)) {
      const merged = tokens.map((t) => t.norm).join('');
      tokens = [{ raw: merged, norm: merged, masked: hasMask(merged) }];
    }
    const joined = tokens.map((t) => t.norm).join('');
    if (!joined || joined.length > 64) return null;
    return {
      raw: cleaned.toLowerCase(),
      tokens,
      joined,
      first: joined[0],
      length: joined.length,
      isPhrase: tokens.length > 1,
      masked: hasMask(joined),
    };
  }

  function buildIndex(words, sensitivity = 'smart') {
    const mode = ['strict', 'smart', 'aggressive'].includes(sensitivity)
      ? sensitivity
      : 'smart';
    const entries = [];
    const seen = new Set();
    for (const word of words || []) {
      const entry = buildEntry(word);
      if (!entry) continue;
      const key = entryKey(entry.tokens);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }

    const exactSingles = new Map();
    const maskedSingles = [];
    const fuzzySinglesByFirst = new Map();
    const allSingles = [];
    const phrasesByLength = new Map();
    const collapsedPhrases = [];
    let maxPhraseTokens = 1;
    let maxJoinTokens = 1;

    for (const entry of entries) {
      if (entry.isPhrase) {
        const list = phrasesByLength.get(entry.tokens.length) || [];
        list.push(entry);
        phrasesByLength.set(entry.tokens.length, list);
        maxPhraseTokens = Math.max(maxPhraseTokens, entry.tokens.length);
        if (entry.length >= 4) collapsedPhrases.push(entry);
      } else {
        allSingles.push(entry);
        if (entry.masked) {
          maskedSingles.push(entry);
        } else {
          if (!exactSingles.has(entry.joined)) exactSingles.set(entry.joined, entry);
          if (maxDistanceFor(entry.length, mode) > 0) {
            const first = entry.joined[0];
            const list = fuzzySinglesByFirst.get(first) || [];
            list.push(entry);
            fuzzySinglesByFirst.set(first, list);
          }
        }
        // Single-word entries can still match split compounds like
        // "mother fucker" when the entry is long enough to be meaningful.
        if (!entry.isPhrase && entry.length >= 4) {
          maxJoinTokens = Math.max(maxJoinTokens, 1);
        }
      }
    }
    // We only need joined n-grams for entries long enough to be a compound.
    // (At least six characters; "dumb ass" → dumbass, "mother fucker", etc.)
    const joinedNgramEntries = allSingles.filter((e) => e.length >= 6);
    const maxJoinedEntryLength = joinedNgramEntries.reduce((max, e) => Math.max(max, e.length), 0);
    maxJoinTokens = Math.min(5, Math.max(2, Math.ceil(maxJoinedEntryLength / 2)));

    const phraseMax = Math.min(8, Math.max(1, maxPhraseTokens));

    function entryMatchesNorm(norm, entry) {
      const budget = maxDistanceFor(entry.length, mode);
      // Compute the true distance; words are short, and masks may span
      // several characters (f***k), so early exit bounds can hide a match.
      const distance = wildcardDistance(norm, entry.joined, 64);
      if (distance === 0) {
        return { entry, rule: entry.masked || hasMask(norm) ? 'masked' : 'exact', distance: 0 };
      }
      if (distance > budget) return null;
      // Approximate matches need the same first letter and must not be a
      // known innocent look-alike.
      if (norm[0] !== entry.joined[0]) return null;
      if (ALLOW_WORDS.has(norm)) return null;
      return { entry, rule: 'fuzzy', distance };
    }

    /** Find the best match for one normalized token. */
    function matchSingleNorm(norm) {
      if (!norm) return null;
      const masked = hasMask(norm);
      const candidates = new Set();
      if (!masked) {
        const exact = exactSingles.get(norm);
        if (exact) return { entry: exact, rule: 'exact', distance: 0 };
        const fuzzyList = fuzzySinglesByFirst.get(norm[0]);
        if (fuzzyList) for (const entry of fuzzyList) candidates.add(entry);
      } else {
        // A censored token can match a normal entry even when the entry's
        // length is below the fuzzy threshold, because the wildcard match is
        // treated as exact.
        if (norm[0] !== '*' && norm[0] !== '#' && norm[0] !== '•' && norm[0] !== '·' && norm[0] !== '＊' && norm[0] !== '✱') {
          const list = fuzzySinglesByFirst.get(norm[0]);
          if (list) for (const entry of list) candidates.add(entry);
        }
        for (const entry of allSingles) {
          if (masked || entry.masked) candidates.add(entry);
        }
      }
      for (const entry of maskedSingles) candidates.add(entry);

      let best = null;
      for (const entry of candidates) {
        const maskedLength = hasMask(norm) || entry.masked;
        const slack = maskedLength ? 8 : Math.max(maxDistanceFor(entry.length, mode), 1);
        if (Math.abs(norm.length - entry.length) > slack) continue;
        const result = entryMatchesNorm(norm, entry);
        if (!result) continue;
        if (!best) {
          best = result;
          continue;
        }
        if (result.distance < best.distance) best = result;
        else if (result.distance === best.distance) {
          if (result.entry.length > best.entry.length) best = result;
        }
      }
      return best;
    }

    function gapIsJoinable(text, fromEnd, toStart, allowComma) {
      if (toStart < fromEnd) return false;
      const gap = text.slice(fromEnd, toStart);
      if (gap.length > 5) return false;
      const re = allowComma ? /^[\s,'’\-\u2013\u2014]*$/u : /^[\s'’\-\u2013\u2014]*$/u;
      return re.test(gap);
    }

    function gapIsSingleLetterJoin(text, fromEnd, toStart) {
      if (toStart < fromEnd) return false;
      const gap = text.slice(fromEnd, toStart);
      if (gap.length > 4) return false;
      return !/[\p{L}\p{N}]/u.test(gap);
    }

    function findMatchesInTokens(tokens, text) {
      const matches = [];
      if (!tokens.length) return matches;

      // 1) Individual tokens (includes censored and fuzzy forms).
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const result = matchSingleNorm(token.norm);
        if (result) {
          matches.push({
            entry: result.entry,
            rule: result.rule,
            start: token.start,
            end: token.end,
            tokenStart: i,
            tokenEnd: i,
            matchedText: token.raw,
          });
        }
        // A hyphenated phrase can contain a flagged word even when the joined
        // form is not in the list (for example "fucked-up"). Keep the match
        // offsets on the actual component so muting doesn't cover its neighbors.
        const hyphenParts = /[\p{L}\p{N}*#•·＊✱]+/gu;
        let part;
        while ((part = hyphenParts.exec(token.raw))) {
          if (part.index === 0 && part[0].length === token.raw.length) continue;
          const partNorm = normalizeToken(part[0]);
          const partResult = matchSingleNorm(partNorm);
          if (!partResult) continue;
          matches.push({
            entry: partResult.entry,
            rule: partResult.rule,
            start: token.start + part.index,
            end: token.start + part.index + part[0].length,
            tokenStart: i,
            tokenEnd: i,
            matchedText: part[0],
          });
        }
        // A collapsed phrase entry can match one hyphenated token.
        if (token.norm.length >= 4) {
          for (const entry of collapsedPhrases) {
            if (Math.abs(token.norm.length - entry.length) > Math.max(maxDistanceFor(entry.length, mode), 0)) {
              continue;
            }
            const result2 = entryMatchesNorm(token.norm, entry);
            if (!result2) continue;
            matches.push({
              entry: result2.entry,
              rule: result2.rule,
              start: token.start,
              end: token.end,
              tokenStart: i,
              tokenEnd: i,
              matchedText: token.raw,
            });
          }
        }
      }

      // 2) Edge-censored forms such as "a$$", "shit!" and "$hit". The normal
      // tokenizer handles internal censorship; this covers edge punctuation
      // that doubles as a letter.
      EDGE_RE.lastIndex = 0;
      let edgeMatch;
      while ((edgeMatch = EDGE_RE.exec(text))) {
        const [raw, lead, core, trail] = edgeMatch;
        if (!lead && !trail) continue;
        const variants = new Set();
        for (let li = 0; li <= lead.length; li++) {
          for (let ti = 0; ti <= trail.length; ti++) {
            const candidate = lead.slice(0, li) + core + trail.slice(0, ti);
            const norm = normalizeToken(candidate);
            if (norm) variants.add(norm);
          }
        }
        let best = null;
        for (const norm of variants) {
          const result = matchSingleNorm(norm);
          if (!result) continue;
          if (
            !best ||
            result.distance < best.distance ||
            (result.distance === best.distance && result.entry.length > best.entry.length)
          ) {
            best = result;
          }
        }
        if (!best) continue;
        const start = edgeMatch.index;
        const end = start + raw.length;
        let tokenStart = -1;
        let tokenEnd = -1;
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i].end > start && tokens[i].start < end) {
            if (tokenStart < 0) tokenStart = i;
            tokenEnd = i;
          }
        }
        matches.push({
          entry: best.entry,
          rule: best.distance > 0 ? 'fuzzy' : 'masked',
          start,
          end,
          tokenStart,
          tokenEnd,
          matchedText: raw,
        });
      }

      // 3) Multi-word entries, compared token by token.
      for (let i = 0; i < tokens.length; i++) {
        for (let n = 2; n <= phraseMax && i + n <= tokens.length; n++) {
          const list = phrasesByLength.get(n);
          if (!list) continue;
          const firstToken = tokens[i];
          const lastToken = tokens[i + n - 1];
          if (!gapIsJoinable(text, firstToken.end, tokens[i + 1].start, true)) continue;
          for (const entry of list) {
            let ok = true;
            let distance = 0;
            let masked = false;
            for (let k = 0; k < n; k++) {
              const cueToken = tokens[i + k];
              const entryToken = entry.tokens[k];
              if (!gapIsJoinable(text, cueToken.end, tokens[i + k + 1]?.start ?? cueToken.end, true) && k < n - 1) {
                ok = false;
                break;
              }
              const budget = maxDistanceFor(entryToken.norm.length, mode);
              const d = wildcardDistance(cueToken.norm, entryToken.norm, 64);
              if (d > budget) {
                ok = false;
                break;
              }
              if (d > 0) {
                if (cueToken.norm[0] !== entryToken.norm[0]) {
                  ok = false;
                  break;
                }
                if (ALLOW_WORDS.has(cueToken.norm)) {
                  ok = false;
                  break;
                }
              }
              distance += d;
              if (hasMask(cueToken.norm) || hasMask(entryToken.norm)) masked = true;
            }
            if (!ok) continue;
            matches.push({
              entry,
              rule: distance > 0 ? 'fuzzy' : masked ? 'masked' : 'exact',
              start: firstToken.start,
              end: lastToken.end,
              tokenStart: i,
              tokenEnd: i + n - 1,
              matchedText: text.slice(firstToken.start, lastToken.end),
            });
          }
        }
      }

      // 4) Consecutive single letters: "f u c k", "f.u.c.k".
      let runStart = 0;
      while (runStart < tokens.length) {
        if (tokens[runStart].norm.length !== 1) {
          runStart++;
          continue;
        }
        let runEnd = runStart;
        while (runEnd + 1 < tokens.length && tokens[runEnd + 1].norm.length === 1) {
          if (!gapIsSingleLetterJoin(text, tokens[runEnd].end, tokens[runEnd + 1].start)) break;
          runEnd++;
        }
        const count = runEnd - runStart + 1;
        if (count >= 3 && count <= 20) {
          const combined = tokens.slice(runStart, runEnd + 1).map((t) => t.norm).join('');
          const result = matchSingleNorm(combined);
          if (result) {
            matches.push({
              entry: result.entry,
              rule: 'spelled',
              start: tokens[runStart].start,
              end: tokens[runEnd].end,
              tokenStart: runStart,
              tokenEnd: runEnd,
              matchedText: text.slice(tokens[runStart].start, tokens[runEnd].end),
            });
          }
        }
        runStart = runEnd + 1;
      }

      // 4) Split compounds: "mother fucker" / "dumb ass" / "bull shit".
      if (joinedNgramEntries.length) {
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i].norm.length < 2) continue;
          let joined = tokens[i].norm;
          for (let n = 2; n <= maxJoinTokens && i + n <= tokens.length; n++) {
            const token = tokens[i + n - 1];
            if (!gapIsJoinable(text, tokens[i + n - 2].end, token.start, false)) break;
            joined += token.norm;
            if (joined.length > 24) break;
            for (const entry of joinedNgramEntries) {
              if (entry.length !== joined.length) continue;
              if (wildcardDistance(joined, entry.joined, 0) !== 0) continue;
              matches.push({
                entry,
                rule: entry.masked || hasMask(joined) ? 'masked' : 'joined',
                start: tokens[i].start,
                end: token.end,
                tokenStart: i,
                tokenEnd: i + n - 1,
                matchedText: text.slice(tokens[i].start, token.end),
              });
            }
          }
        }
      }

      return resolveOverlaps(matches);
    }

    function resolveOverlaps(matches) {
      if (matches.length <= 1) return matches;
      const sorted = [...matches].sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        const lenA = a.end - a.start;
        const lenB = b.end - b.start;
        if (lenA !== lenB) return lenB - lenA;
        return (a.entry.length || 0) - (b.entry.length || 0);
      });
      const accepted = [];
      for (const match of sorted) {
        let blocked = false;
        for (let i = 0; i < accepted.length; i++) {
          const current = accepted[i];
          const overlaps = match.start < current.end && match.end > current.start;
          if (!overlaps) continue;
          const matchLen = match.end - match.start;
          const currentLen = current.end - current.start;
          if (match.start >= current.start && match.end <= current.end) {
            blocked = true;
            break;
          }
          if (match.start <= current.start && match.end >= current.end && matchLen > currentLen) {
            accepted.splice(i, 1);
            i--;
            continue;
          }
          blocked = true;
          break;
        }
        if (!blocked) accepted.push(match);
      }
      accepted.sort((a, b) => a.start - b.start);
      return accepted;
    }

    function analyze(text) {
      const tokens = tokenize(text || '');
      return { tokens, matches: findMatchesInTokens(tokens, text || '') };
    }

    return {
      sensitivity: mode,
      entries,
      analyze,
      tokenize,
      findMatches: (tokens, text) => findMatchesInTokens(tokens, text || ''),
    };
  }

  NS.Matcher = {
    buildIndex,
    tokenize,
    normalizeToken,
    wildcardDistance,
    maxDistanceFor,
    hasMask,
    ALLOW_WORDS,
    MASK_CLASS,
  };
})();
