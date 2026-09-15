// ---------------------------------------------------------------------------
// Mihon / Tachiyomi backup reader
//
// A .tachibk file is a gzipped Protobuf message with no embedded schema, so we
// decode the wire format generically and then pick out fields by number using
// Mihon's Backup*.kt definitions.
//
// If a future Mihon release shuffles these numbers, this is the only block that
// needs touching.
// ---------------------------------------------------------------------------

const MIHON_FIELDS = {
  backup: { manga: 1, categories: 2 },
  manga: {
    source: 1, url: 2, title: 3, artist: 4, author: 5, description: 6,
    genre: 7, status: 8, thumbnailUrl: 9, dateAdded: 13, chapters: 16,
    categories: 17, tracking: 18, favorite: 19, history: 23,
  },
  chapter: {
    url: 1, name: 2, scanlator: 3, read: 4, bookmark: 5, lastPageRead: 6,
    dateFetch: 7, dateUpload: 8, chapterNumber: 9, sourceOrder: 10,
  },
  category: { name: 1, order: 2 },
  // BackupTracking — lets us recover a MAL id when the user had tracking on
  tracking: { syncId: 1, mediaId: 2, libraryId: 3, title: 4, lastRead: 5, score: 7, status: 8, remoteUrl: 9 },
};

// Tracker ids as used by Tachiyomi/Mihon's TrackManager
const TRACKER_MAL = 1;
const TRACKER_ANILIST = 2;

// ---------------------------------------------------------------------------
// Generic protobuf wire decoding
// ---------------------------------------------------------------------------
function readVarint(buf, pos) {
  let result = 0;
  let shift = 1;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) throw new Error("varint too large");
  }
  return [result, pos];
}

// Returns { fieldNumber: [ {wire, value} ... ] }
function pbDecode(buf) {
  const out = {};
  let p = 0;
  while (p < buf.length) {
    let key;
    [key, p] = readVarint(buf, p);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value;
    if (wire === 0) {
      [value, p] = readVarint(buf, p);
    } else if (wire === 1) {
      value = buf.subarray(p, p + 8); p += 8;
    } else if (wire === 2) {
      let len;
      [len, p] = readVarint(buf, p);
      value = buf.subarray(p, p + len); p += len;
    } else if (wire === 5) {
      value = buf.subarray(p, p + 4); p += 4;
    } else {
      throw new Error("unsupported wire type " + wire);
    }
    (out[field] ||= []).push({ wire, value });
  }
  return out;
}

const dec = new TextDecoder("utf-8", { fatal: false });

function pbStr(msg, field) {
  const e = msg[field]?.[0];
  return e && e.wire === 2 ? dec.decode(e.value) : "";
}
function pbStrList(msg, field) {
  return (msg[field] || []).filter((e) => e.wire === 2).map((e) => dec.decode(e.value));
}
function pbNum(msg, field, dflt = 0) {
  const e = msg[field]?.[0];
  if (!e) return dflt;
  if (e.wire === 0) return e.value;
  if (e.wire === 5) return new DataView(e.value.buffer, e.value.byteOffset, 4).getFloat32(0, true);
  return dflt;
}
function pbBool(msg, field) {
  return pbNum(msg, field, 0) === 1;
}
function pbSubs(msg, field) {
  return (msg[field] || []).filter((e) => e.wire === 2).map((e) => pbDecode(e.value));
}
// repeated int32 — proto3 packs these into one length-delimited chunk
function pbIntList(msg, field) {
  const out = [];
  (msg[field] || []).forEach((e) => {
    if (e.wire === 0) { out.push(e.value); return; }
    if (e.wire !== 2) return;
    let p = 0;
    while (p < e.value.length) {
      let v;
      [v, p] = readVarint(e.value, p);
      out.push(v);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// gunzip via the browser's built-in DecompressionStream
// ---------------------------------------------------------------------------
async function maybeGunzip(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes; // already plain
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't un-gzip the backup. Try Chrome, Edge or Firefox.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Parse a backup file into a shape Omoidebako understands
// ---------------------------------------------------------------------------
async function parseMihonBackup(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  const bytes = await maybeGunzip(raw);

  let root;
  try {
    root = pbDecode(bytes);
  } catch (err) {
    throw new Error("Couldn't read that file as a Mihon backup (" + err.message + ").");
  }

  const F = MIHON_FIELDS;

  // categories become folders. Mihon references them from a manga by their
  // `order` value, so index on that.
  const categories = {};
  pbSubs(root, F.backup.categories).forEach((c) => {
    const name = pbStr(c, F.category.name);
    const order = pbNum(c, F.category.order, 0);
    if (name) categories[order] = name;
  });

  const mangaMsgs = pbSubs(root, F.backup.manga);
  if (mangaMsgs.length === 0) {
    throw new Error("No manga found in that file. Make sure it's a full Mihon backup (.tachibk), not a settings-only export.");
  }

  const series = mangaMsgs.map((m) => {
    const chapters = pbSubs(m, F.manga.chapters).map((c) => ({
      name: pbStr(c, F.chapter.name),
      scanlator: pbStr(c, F.chapter.scanlator),
      read: pbBool(c, F.chapter.read),
      lastPageRead: pbNum(c, F.chapter.lastPageRead, 0),
      number: pbNum(c, F.chapter.chapterNumber, 0),
    }));

    // Progress = the highest numbered chapter actually marked read. Counting
    // read rows would over-count when several scanlator releases of the same
    // chapter are in the library.
    const readChapters = chapters.filter((c) => c.read);
    const highestRead = readChapters.reduce((max, c) => (c.number > max ? c.number : max), 0);
    const highestKnown = chapters.reduce((max, c) => (c.number > max ? c.number : max), 0);

    // A chapter that's part-read but not finished still counts as "in progress"
    const partial = chapters.some((c) => !c.read && c.lastPageRead > 0);

    // tracking rows can hand us a MAL id for free
    let malId = null;
    let anilistId = null;
    let trackScore = null;
    pbSubs(m, F.manga.tracking).forEach((t) => {
      const syncId = pbNum(t, F.tracking.syncId, 0);
      const mediaId = pbNum(t, F.tracking.mediaId, 0);
      const score = pbNum(t, F.tracking.score, 0);
      if (syncId === TRACKER_MAL && mediaId) malId = mediaId;
      if (syncId === TRACKER_ANILIST && mediaId) anilistId = mediaId;
      if (score > 0 && trackScore == null) trackScore = score;
    });

    const folders = pbIntList(m, F.manga.categories)
      .map((ord) => categories[ord])
      .filter(Boolean);

    return {
      title: pbStr(m, F.manga.title) || "Untitled",
      author: pbStr(m, F.manga.author) || pbStr(m, F.manga.artist) || "",
      description: pbStr(m, F.manga.description) || "",
      genres: pbStrList(m, F.manga.genre),
      thumbnailUrl: pbStr(m, F.manga.thumbnailUrl) || "",
      publicationStatus: pbNum(m, F.manga.status, 0),
      dateAdded: pbNum(m, F.manga.dateAdded, 0),
      favorite: m[F.manga.favorite] ? pbBool(m, F.manga.favorite) : true,
      sourceUrl: pbStr(m, F.manga.url),
      chapterCount: chapters.length,
      readCount: readChapters.length,
      progress: Math.floor(highestRead),
      highestChapter: Math.floor(highestKnown),
      partial,
      malId,
      anilistId,
      trackScore,
      folders,
      folder: folders[0] || null,
    };
  });

  return { series, categories: Object.values(categories) };
}

// Map a parsed series onto an Omoidebako status
function mihonStatus(s) {
  if (s.readCount === 0) return s.partial ? "watching" : "plan";
  if (s.chapterCount > 0 && s.readCount >= s.chapterCount) return "completed";
  return "watching";
}

window.OmoideMihon = { parseMihonBackup, mihonStatus };
