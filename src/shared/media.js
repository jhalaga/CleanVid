/**
 * CleanVid — media stream parsing.
 *
 * YouTube's player appends audio to Media Source Extensions as WebM (Opus) or
 * fragmented MP4 (AAC). The player may append whole segments or arbitrary byte
 * slices, may seek and start again from another segment, and may switch audio
 * formats. This module turns that raw append stream into self-contained,
 * timestamped audio units that can be decoded independently:
 *
 *   WebM: one unit per Cluster; init = EBML header + Segment(Info, Tracks)
 *   MP4:  one unit per moof+mdat pair; init = ftyp + moov
 *
 * Each unit carries its presentation start time (container timestamp plus the
 * SourceBuffer's timestampOffset) and its exact duration (Opus packet TOC
 * bytes, or MP4 trun sample durations). The exact duration lets the decoder
 * detect and correct samples the browser trims at the start of a decode
 * (Opus pre-skip, AAC priming), which keeps mute timing precise.
 *
 * Exposes CleanVid.Media. Pure JavaScript; runs in pages, workers and Node.
 */
(() => {
  const NS = (globalThis.CleanVid = globalThis.CleanVid || {});
  if (NS.Media) return;

  const MAX_ELEMENT = 64 * 1024 * 1024;
  const MAX_PENDING = 96 * 1024 * 1024;

  // --- Byte helpers ---------------------------------------------------------

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(0);
  }

  function concatBytes(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function readUint(bytes, offset, length) {
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i];
    return value;
  }

  function fourcc(bytes, offset) {
    return String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
  }

  function base64FromBytes(bytes) {
    const data = toBytes(bytes);
    if (typeof Buffer !== 'undefined' && typeof btoa === 'undefined') {
      return Buffer.from(data).toString('base64');
    }
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < data.length; i += step) {
      binary += String.fromCharCode.apply(null, data.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function bytesFromBase64(text) {
    if (typeof Buffer !== 'undefined' && typeof atob === 'undefined') {
      return new Uint8Array(Buffer.from(String(text || ''), 'base64'));
    }
    const binary = atob(String(text || ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function containerFromMime(mime) {
    const value = String(mime || '').toLowerCase();
    if (value.includes('webm')) return 'webm';
    if (value.includes('mp4')) return 'mp4';
    return '';
  }

  // --- Opus packet durations (RFC 6716 §3.1) --------------------------------

  function opusPacketDuration(packet) {
    if (!packet || !packet.length) return 0;
    const toc = packet[0];
    const config = toc >> 3;
    let frameMs;
    if (config < 12) frameMs = [10, 20, 40, 60][config & 3];
    else if (config < 16) frameMs = [10, 20][config & 1];
    else frameMs = [2.5, 5, 10, 20][config & 3];
    const code = toc & 3;
    let frames = 1;
    if (code === 1 || code === 2) frames = 2;
    else if (code === 3) frames = packet.length > 1 ? packet[1] & 0x3f : 0;
    return (frames * frameMs) / 1000;
  }

  // --- EBML / WebM ----------------------------------------------------------

  const EBML_ID = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    CodecID: 0x86,
    CodecDelay: 0x56aa,
    Audio: 0xe1,
    SamplingFrequency: 0xb5,
    Channels: 0x9f,
    Cues: 0x1c53bb6b,
    Tags: 0x1254c367,
    Chapters: 0x1043a770,
    Attachments: 0x1941a469,
    Void: 0xec,
    Cluster: 0x1f43b675,
    Timecode: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    BlockDuration: 0x9b,
  };

  const TOP_LEVEL_IDS = new Set([
    EBML_ID.EBML,
    EBML_ID.Segment,
    EBML_ID.SeekHead,
    EBML_ID.Info,
    EBML_ID.Tracks,
    EBML_ID.Cues,
    EBML_ID.Tags,
    EBML_ID.Chapters,
    EBML_ID.Attachments,
    EBML_ID.Void,
    EBML_ID.Cluster,
  ]);

  /** Read an EBML element ID (marker bits kept). */
  function readEbmlId(bytes, offset) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    let length = 0;
    if (first & 0x80) length = 1;
    else if (first & 0x40) length = 2;
    else if (first & 0x20) length = 3;
    else if (first & 0x10) length = 4;
    else return { invalid: true };
    if (offset + length > bytes.length) return null;
    return { id: readUint(bytes, offset, length), length };
  }

  /** Read an EBML size vint. `unknown` is true for the all-ones value. */
  function readEbmlSize(bytes, offset) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) {
      length += 1;
      mask >>= 1;
    }
    if (length > 8) return { invalid: true };
    if (offset + length > bytes.length) return null;
    let value = first & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < length; i++) {
      const byte = bytes[offset + i];
      if (byte !== 0xff) allOnes = false;
      value = value * 256 + byte;
    }
    return { value, length, unknown: allOnes };
  }

  /** Iterate the complete children of a master element body. */
  function* ebmlChildren(bytes, start, end) {
    let offset = start;
    while (offset < end) {
      const id = readEbmlId(bytes, offset);
      if (!id || id.invalid) return;
      const size = readEbmlSize(bytes, offset + id.length);
      if (!size || size.invalid) return;
      const dataStart = offset + id.length + size.length;
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
      yield { id: id.id, start: offset, dataStart, dataEnd };
      offset = dataEnd;
    }
  }

  function parseWebmTracks(bytes, start, end, info) {
    for (const entry of ebmlChildren(bytes, start, end)) {
      if (entry.id !== EBML_ID.TrackEntry) continue;
      for (const field of ebmlChildren(bytes, entry.dataStart, entry.dataEnd)) {
        if (field.id === EBML_ID.CodecID) {
          info.codec = String.fromCharCode(...bytes.subarray(field.dataStart, field.dataEnd));
        } else if (field.id === EBML_ID.CodecDelay) {
          info.codecDelayNs = readUint(bytes, field.dataStart, field.dataEnd - field.dataStart);
        } else if (field.id === EBML_ID.Audio) {
          for (const audio of ebmlChildren(bytes, field.dataStart, field.dataEnd)) {
            if (audio.id === EBML_ID.Channels) {
              info.channels = readUint(bytes, audio.dataStart, audio.dataEnd - audio.dataStart);
            } else if (audio.id === EBML_ID.SamplingFrequency) {
              const view = new DataView(bytes.buffer, bytes.byteOffset + audio.dataStart, audio.dataEnd - audio.dataStart);
              info.sampleRate = audio.dataEnd - audio.dataStart === 8 ? view.getFloat64(0) : view.getFloat32(0);
            }
          }
        }
      }
      return;
    }
  }

  function parseCluster(bytes, start, end, info) {
    let clusterTime = 0;
    const blocks = [];
    const readBlock = (dataStart, dataEnd, explicitDuration) => {
      const track = readEbmlSize(bytes, dataStart);
      if (!track || track.invalid) return;
      const header = dataStart + track.length;
      if (header + 3 > dataEnd) return;
      let relative = (bytes[header] << 8) | bytes[header + 1];
      if (relative & 0x8000) relative -= 0x10000;
      const flags = bytes[header + 2];
      const lacing = (flags >> 1) & 3;
      const payload = bytes.subarray(header + 3, dataEnd);
      let duration = 0;
      if (lacing === 0 && /OPUS/i.test(info.codec || 'A_OPUS')) {
        duration = opusPacketDuration(payload);
      }
      blocks.push({ relative, duration, explicitDuration });
    };
    for (const child of ebmlChildren(bytes, start, end)) {
      if (child.id === EBML_ID.Timecode) {
        clusterTime = readUint(bytes, child.dataStart, child.dataEnd - child.dataStart);
      } else if (child.id === EBML_ID.SimpleBlock) {
        readBlock(child.dataStart, child.dataEnd, 0);
      } else if (child.id === EBML_ID.BlockGroup) {
        let block = null;
        let blockDuration = 0;
        for (const part of ebmlChildren(bytes, child.dataStart, child.dataEnd)) {
          if (part.id === EBML_ID.Block) block = part;
          else if (part.id === EBML_ID.BlockDuration) {
            blockDuration = readUint(bytes, part.dataStart, part.dataEnd - part.dataStart);
          }
        }
        if (block) readBlock(block.dataStart, block.dataEnd, blockDuration);
      }
    }
    if (!blocks.length) return null;
    const scale = (info.timecodeScale || 1000000) / 1e9;
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    let duration = blocks.reduce((sum, block) => sum + block.duration, 0);
    if (!(duration > 0)) {
      // Not Opus (or laced): estimate from block timecodes.
      const span = (last.relative - first.relative) * scale;
      const step = blocks.length > 1 ? span / (blocks.length - 1) : 0.02;
      duration = span + (last.explicitDuration ? last.explicitDuration * scale : step);
    }
    return {
      start: (clusterTime + first.relative) * scale,
      duration,
      exact: blocks.every((block) => block.duration > 0),
      blocks: blocks.length,
    };
  }

  function createWebmParser() {
    let pending = new Uint8Array(0);
    let header = null; // EBML header element bytes
    let info = { timecodeScale: 1000000, codec: '', codecDelayNs: 0 };
    let infoBytes = null;
    let tracksBytes = null;
    let init = null;
    let initVersion = 0;
    let skip = 0;

    function rebuildInit() {
      if (!header || !tracksBytes) return;
      const children = concatBytes([infoBytes || new Uint8Array(0), tracksBytes]);
      // Segment with an 8-byte all-ones ("unknown") size, so any number of
      // clusters can follow and stale SeekHead/Cues offsets are not needed.
      const segmentHeader = new Uint8Array([
        0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ]);
      init = concatBytes([header, segmentHeader, children]);
      initVersion += 1;
    }

    function resync(bytes, from) {
      // Find the next Cluster or EBML header marker.
      for (let i = Math.max(0, from); i + 4 <= bytes.length; i++) {
        const b0 = bytes[i];
        if (
          (b0 === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) ||
          (b0 === 0x1a && bytes[i + 1] === 0x45 && bytes[i + 2] === 0xdf && bytes[i + 3] === 0xa3)
        ) {
          return i;
        }
      }
      return Math.max(0, bytes.length - 3);
    }

    function push(chunk, timestampOffset = 0) {
      const units = [];
      let bytes = pending.length ? concatBytes([pending, toBytes(chunk)]) : toBytes(chunk).slice();
      let offset = 0;
      let initChanged = false;

      if (skip > 0) {
        const step = Math.min(skip, bytes.length);
        skip -= step;
        offset = step;
      }

      while (offset < bytes.length) {
        const id = readEbmlId(bytes, offset);
        if (!id) break;
        if (id.invalid || !TOP_LEVEL_IDS.has(id.id)) {
          offset = resync(bytes, offset + 1);
          continue;
        }
        const size = readEbmlSize(bytes, offset + id.length);
        if (!size) break;
        if (size.invalid) {
          offset = resync(bytes, offset + 1);
          continue;
        }
        const dataStart = offset + id.length + size.length;

        if (id.id === EBML_ID.Segment) {
          // Descend: Segment children are parsed as top-level elements.
          offset = dataStart;
          continue;
        }

        if (size.unknown) {
          if (id.id !== EBML_ID.Cluster) {
            offset = resync(bytes, offset + 1);
            continue;
          }
          // Unknown-size cluster: it ends at the next top-level marker.
          const next = resync(bytes, dataStart);
          if (next >= bytes.length - 3) break;
          const unit = parseCluster(bytes, dataStart, next, info);
          if (unit && init) {
            units.push(makeUnit(unit, bytes.slice(offset, next), timestampOffset));
          }
          offset = next;
          continue;
        }

        if (size.value > MAX_ELEMENT) {
          offset = resync(bytes, offset + 1);
          continue;
        }
        const end = dataStart + size.value;

        if (id.id === EBML_ID.Cluster || id.id === EBML_ID.EBML || id.id === EBML_ID.Info || id.id === EBML_ID.Tracks) {
          if (end > bytes.length) break; // wait for the rest
          if (id.id === EBML_ID.EBML) {
            header = bytes.slice(offset, end);
            infoBytes = null;
            tracksBytes = null;
            info = { timecodeScale: 1000000, codec: '', codecDelayNs: 0 };
          } else if (id.id === EBML_ID.Info) {
            infoBytes = bytes.slice(offset, end);
            for (const child of ebmlChildren(bytes, dataStart, end)) {
              if (child.id === EBML_ID.TimecodeScale) {
                info.timecodeScale = readUint(bytes, child.dataStart, child.dataEnd - child.dataStart) || 1000000;
              }
            }
          } else if (id.id === EBML_ID.Tracks) {
            tracksBytes = bytes.slice(offset, end);
            parseWebmTracks(bytes, dataStart, end, info);
            rebuildInit();
            initChanged = true;
          } else if (id.id === EBML_ID.Cluster && init) {
            const unit = parseCluster(bytes, dataStart, end, info);
            if (unit) units.push(makeUnit(unit, bytes.slice(offset, end), timestampOffset));
          }
          offset = end;
          continue;
        }

        // Elements we do not need (SeekHead, Cues, Void, Tags…): skip them,
        // even before they are fully buffered.
        if (end > bytes.length) {
          skip = end - bytes.length;
          offset = bytes.length;
          break;
        }
        offset = end;
      }

      pending = offset < bytes.length ? bytes.slice(offset) : new Uint8Array(0);
      if (pending.length > MAX_PENDING) pending = new Uint8Array(0);
      return { units, init: initChanged ? init : null };
    }

    function makeUnit(unit, bytes, timestampOffset) {
      return {
        start: unit.start + (Number(timestampOffset) || 0),
        duration: unit.duration,
        exact: unit.exact,
        bytes,
        initVersion,
      };
    }

    return {
      container: 'webm',
      push,
      reset() {
        pending = new Uint8Array(0);
        skip = 0;
      },
      get init() {
        return init;
      },
      get info() {
        return { ...info };
      },
    };
  }

  // --- ISO BMFF / fragmented MP4 -------------------------------------------

  const MP4_TOP = new Set(['ftyp', 'moov', 'moof', 'mdat', 'styp', 'sidx', 'emsg', 'prft', 'free', 'skip', 'mfra', 'uuid']);

  function* mp4Boxes(bytes, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = readUint(bytes, offset, 4);
      const type = fourcc(bytes, offset + 4);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        size = readUint(bytes, offset + 8, 8);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) return;
      yield { type, start: offset, dataStart: offset + headerSize, end: offset + size };
      offset += size;
    }
  }

  function findBox(bytes, start, end, path) {
    let range = { dataStart: start, end };
    for (const type of path) {
      let found = null;
      for (const box of mp4Boxes(bytes, range.dataStart, range.end)) {
        if (box.type === type) {
          found = box;
          break;
        }
      }
      if (!found) return null;
      range = found;
    }
    return range;
  }

  function parseMoov(bytes, start, end, info) {
    for (const trak of mp4Boxes(bytes, start, end)) {
      if (trak.type !== 'trak') continue;
      const mdhd = findBox(bytes, trak.dataStart, trak.end, ['mdia', 'mdhd']);
      if (mdhd) {
        const version = bytes[mdhd.dataStart];
        info.timescale = readUint(bytes, mdhd.dataStart + (version === 1 ? 20 : 12), 4) || info.timescale;
      }
    }
    const mvex = findBox(bytes, start, end, ['mvex']);
    if (mvex) {
      for (const box of mp4Boxes(bytes, mvex.dataStart, mvex.end)) {
        if (box.type === 'trex') {
          info.defaultSampleDuration = readUint(bytes, box.dataStart + 12, 4);
        }
      }
    }
  }

  function parseMoof(bytes, start, end, info) {
    let baseTime = null;
    let duration = 0;
    let samples = 0;
    for (const traf of mp4Boxes(bytes, start, end)) {
      if (traf.type !== 'traf') continue;
      let defaultDuration = info.defaultSampleDuration || 0;
      for (const box of mp4Boxes(bytes, traf.dataStart, traf.end)) {
        if (box.type === 'tfhd') {
          const flags = readUint(bytes, box.dataStart + 1, 3);
          let cursor = box.dataStart + 8;
          if (flags & 0x01) cursor += 8;
          if (flags & 0x02) cursor += 4;
          if (flags & 0x08) defaultDuration = readUint(bytes, cursor, 4);
        } else if (box.type === 'tfdt') {
          const version = bytes[box.dataStart];
          baseTime = readUint(bytes, box.dataStart + 4, version === 1 ? 8 : 4);
        } else if (box.type === 'trun') {
          const flags = readUint(bytes, box.dataStart + 1, 3);
          const count = readUint(bytes, box.dataStart + 4, 4);
          let cursor = box.dataStart + 8;
          if (flags & 0x01) cursor += 4;
          if (flags & 0x04) cursor += 4;
          let stride = 0;
          if (flags & 0x100) stride += 4;
          if (flags & 0x200) stride += 4;
          if (flags & 0x400) stride += 4;
          if (flags & 0x800) stride += 4;
          samples += count;
          if (flags & 0x100) {
            for (let i = 0; i < count && cursor + 4 <= box.end; i++) {
              duration += readUint(bytes, cursor, 4);
              cursor += stride;
            }
          } else {
            duration += count * defaultDuration;
          }
        }
      }
      break; // first (audio) track fragment only
    }
    if (baseTime == null) return null;
    const timescale = info.timescale || 1;
    return {
      start: baseTime / timescale,
      duration: duration / timescale,
      exact: duration > 0,
      blocks: samples,
    };
  }

  function createMp4Parser() {
    let pending = new Uint8Array(0);
    let ftyp = null;
    let init = null;
    let initVersion = 0;
    let moof = null;
    let skip = 0;
    const info = { timescale: 0, defaultSampleDuration: 0 };

    function resync(bytes, from) {
      for (let i = Math.max(4, from); i + 4 <= bytes.length; i++) {
        const type = fourcc(bytes, i);
        if (type === 'moof' || type === 'ftyp' || type === 'styp') return i - 4;
      }
      return Math.max(0, bytes.length - 7);
    }

    function push(chunk, timestampOffset = 0) {
      const units = [];
      let initChanged = false;
      let bytes = pending.length ? concatBytes([pending, toBytes(chunk)]) : toBytes(chunk).slice();
      let offset = 0;
      if (skip > 0) {
        const step = Math.min(skip, bytes.length);
        skip -= step;
        offset = step;
      }

      while (offset + 8 <= bytes.length) {
        let size = readUint(bytes, offset, 4);
        const type = fourcc(bytes, offset + 4);
        let headerSize = 8;
        if (!MP4_TOP.has(type)) {
          offset = resync(bytes, offset + 5);
          moof = null;
          continue;
        }
        if (size === 1) {
          if (offset + 16 > bytes.length) break;
          size = readUint(bytes, offset + 8, 8);
          headerSize = 16;
        }
        if (size < headerSize || size > MAX_ELEMENT * 4) {
          offset = resync(bytes, offset + 5);
          moof = null;
          continue;
        }
        const end = offset + size;
        const needed = type === 'ftyp' || type === 'moov' || type === 'moof' || type === 'mdat';
        if (!needed) {
          if (end > bytes.length) {
            skip = end - bytes.length;
            offset = bytes.length;
            break;
          }
          offset = end;
          continue;
        }
        if (end > bytes.length) break;

        if (type === 'ftyp') {
          ftyp = bytes.slice(offset, end);
        } else if (type === 'moov') {
          parseMoov(bytes, offset + headerSize, end, info);
          init = concatBytes([ftyp || new Uint8Array(0), bytes.slice(offset, end)]);
          initVersion += 1;
          initChanged = true;
        } else if (type === 'moof') {
          moof = { bytes: bytes.slice(offset, end), meta: parseMoof(bytes, offset + headerSize, end, info) };
        } else if (type === 'mdat') {
          if (moof && moof.meta && init) {
            units.push({
              start: moof.meta.start + (Number(timestampOffset) || 0),
              duration: moof.meta.duration,
              exact: moof.meta.exact,
              bytes: concatBytes([moof.bytes, bytes.subarray(offset, end)]),
              initVersion,
            });
          }
          moof = null;
        }
        offset = end;
      }

      pending = offset < bytes.length ? bytes.slice(offset) : new Uint8Array(0);
      if (pending.length > MAX_PENDING) pending = new Uint8Array(0);
      return { units, init: initChanged ? init : null };
    }

    return {
      container: 'mp4',
      push,
      reset() {
        pending = new Uint8Array(0);
        moof = null;
        skip = 0;
      },
      get init() {
        return init;
      },
      get info() {
        return { ...info };
      },
    };
  }

  function createParser(mime) {
    const container = containerFromMime(mime);
    if (container === 'webm') return createWebmParser();
    if (container === 'mp4') return createMp4Parser();
    return null;
  }

  /**
   * Build one decodable file from an init segment and consecutive units.
   * WebM: init already has an unknown-size Segment, so clusters just follow.
   */
  function buildDecodable(init, units) {
    return concatBytes([toBytes(init), ...units.map((unit) => toBytes(unit.bytes))]);
  }

  /**
   * Group units (sorted by start) into contiguous runs that share an init.
   * Small gaps (<= tolerance) are treated as contiguous.
   */
  function contiguousRuns(units, tolerance = 0.06) {
    const sorted = [...units].sort((a, b) => a.start - b.start);
    const runs = [];
    let current = null;
    for (const unit of sorted) {
      const end = unit.start + unit.duration;
      if (
        current &&
        unit.initKey === current.initKey &&
        unit.start <= current.end + tolerance &&
        unit.start >= current.end - Math.max(tolerance, 0.5)
      ) {
        current.units.push(unit);
        current.end = Math.max(current.end, end);
      } else if (current && unit.start < current.end - 0.5 && unit.initKey === current.initKey) {
        // Overlapping duplicate (same audio appended twice): ignore.
        continue;
      } else {
        current = { start: unit.start, end, initKey: unit.initKey, units: [unit] };
        runs.push(current);
      }
    }
    return runs;
  }

  NS.Media = {
    createParser,
    createWebmParser,
    createMp4Parser,
    containerFromMime,
    buildDecodable,
    contiguousRuns,
    opusPacketDuration,
    concatBytes,
    toBytes,
    base64FromBytes,
    bytesFromBase64,
  };
})();
