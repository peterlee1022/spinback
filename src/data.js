import { unzipSync, strFromU8 } from 'fflate';

export const TOP_N = 8;
export const PALETTE = ['#ff6b6b', '#ffb547', '#c6f35b', '#3ee6b0', '#4cc9ff', '#8d7bff', '#ff6ad5', '#e9e4ff'];
export const OTHER_COLOR = '#41455f';

// ---------- reading Spotify exports ----------

const HISTORY_RE = /(StreamingHistory|Streaming_History_Audio)[^/]*\.json$/i;

// Accepts the zip Spotify emails you, or the JSON files inside it.
// Handles both "Account data" (StreamingHistory*.json) and
// "Extended streaming history" (Streaming_History_Audio_*.json).
export async function readFiles(files) {
  const basic = [];
  const extended = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.zip')) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = unzipSync(buf, { filter: (f) => HISTORY_RE.test(f.name) });
        for (const data of Object.values(entries)) collect(strFromU8(data), basic, extended);
      } else if (lower.endsWith('.json')) {
        collect(await file.text(), basic, extended);
      }
    } catch (err) {
      console.warn('Skipping', file.name, err);
    }
  }
  // Extended history is a superset with better timestamps, so prefer it.
  return dedupe(extended.length ? extended : basic);
}

function collect(text, basic, extended) {
  let json;
  try { json = JSON.parse(text); } catch { return; }
  if (!Array.isArray(json)) return;
  for (const e of json) {
    if (!e || typeof e !== 'object') continue;
    if ('ts' in e) {
      const r = fromExtended(e);
      if (r) extended.push(r);
    } else if ('endTime' in e) {
      const r = fromBasic(e);
      if (r) basic.push(r);
    }
  }
}

function fromExtended(e) {
  const ms = Number(e.ms_played) || 0;
  const artist = e.master_metadata_album_artist_name || e.episode_show_name || e.audiobook_title;
  const track = e.master_metadata_track_name || e.episode_name || e.audiobook_chapter_title;
  const end = Date.parse(e.ts);
  if (!artist || !track || ms <= 0 || Number.isNaN(end)) return null;
  return { t: end - ms, ms, artist, track };
}

function fromBasic(e) {
  const ms = Number(e.msPlayed) || 0;
  const artist = e.artistName || e.podcastName;
  const track = e.trackName || e.episodeName;
  const end = Date.parse(String(e.endTime).replace(' ', 'T') + 'Z');
  if (!artist || !track || ms <= 0 || Number.isNaN(end)) return null;
  return { t: end - ms, ms, artist, track };
}

function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const key = r.t + '|' + r.track;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------- aggregation ----------

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dayOfYear = (d) =>
  Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 864e5);

export function listYears(records) {
  const m = new Map();
  for (const r of records) {
    const y = new Date(r.t).getFullYear();
    m.set(y, (m.get(y) || 0) + r.ms);
  }
  return [...m].map(([year, ms]) => ({ year, ms })).sort((a, b) => a.year - b.year);
}

// Most recent year that has a decent chunk of listening in it.
export function pickYear(years) {
  const max = Math.max(...years.map((y) => y.ms));
  for (let i = years.length - 1; i >= 0; i--) if (years[i].ms >= max * 0.4) return years[i].year;
  return years[years.length - 1].year;
}

export function buildYear(records, year) {
  const days = isLeap(year) ? 366 : 365;
  const N = days * 24;
  const cells = Array.from({ length: N }, () => []);
  const artistTotals = new Map();
  const tracks = new Set();
  let totalMs = 0;
  let plays = 0;

  for (const r of records) {
    const d = new Date(r.t);
    if (d.getFullYear() !== year) continue;
    cells[dayOfYear(d) * 24 + d.getHours()].push(r);
    totalMs += r.ms;
    if (r.ms >= 30000) plays++;
    artistTotals.set(r.artist, (artistTotals.get(r.artist) || 0) + r.ms);
    tracks.add(r.artist + '\u0000' + r.track);
  }

  const artists = [...artistTotals].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
  const top = artists.slice(0, TOP_N).map((a, i) => ({ ...a, index: i, color: PALETTE[i] }));
  const topIndex = new Map(top.map((a) => [a.name, a.index]));

  const minutes = new Float32Array(N);
  const topOf = new Int8Array(N).fill(-1);
  const perArtist = new Float32Array(TOP_N * N);
  const dayMs = new Float64Array(days);

  for (let i = 0; i < N; i++) {
    const list = cells[i];
    if (!list.length) continue;
    const by = new Map();
    let sum = 0;
    for (const r of list) {
      sum += r.ms;
      by.set(r.artist, (by.get(r.artist) || 0) + r.ms);
    }
    minutes[i] = sum / 60000;
    dayMs[(i / 24) | 0] += sum;
    let best = null;
    let bestMs = -1;
    for (const [a, ms] of by) {
      if (ms > bestMs) { best = a; bestMs = ms; }
      const ti = topIndex.get(a);
      if (ti !== undefined) perArtist[ti * N + i] = ms / 60000;
    }
    topOf[i] = topIndex.has(best) ? topIndex.get(best) : TOP_N;
  }

  // Extra details for the legend tooltips.
  for (const a of top) {
    a.plays = 0;
    a.months = new Float64Array(12);
    a.trackMs = new Map();
  }
  for (const list of cells) {
    for (const r of list) {
      const ti = topIndex.get(r.artist);
      if (ti === undefined) continue;
      const a = top[ti];
      if (r.ms >= 30000) a.plays++;
      a.months[new Date(r.t).getMonth()] += r.ms;
      a.trackMs.set(r.track, (a.trackMs.get(r.track) || 0) + r.ms);
    }
  }
  for (const a of top) {
    a.topTrack = [...a.trackMs].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
    a.peakMonth = a.months.indexOf(Math.max(...a.months));
    delete a.trackMs;
  }

  let busiestDay = 0;
  for (let d = 1; d < days; d++) if (dayMs[d] > dayMs[busiestDay]) busiestDay = d;

  return {
    year, days, N, cells, minutes, topOf, perArtist, dayMs, top, topIndex,
    totalMs, plays, artistCount: artists.length, trackCount: tracks.size, busiestDay,
  };
}

export function cellTracks(data, idx, artist = null, n = 3) {
  const m = new Map();
  for (const r of data.cells[idx]) {
    if (artist && r.artist !== artist) continue;
    const k = r.track + '\u0000' + r.artist;
    m.set(k, (m.get(k) || 0) + r.ms);
  }
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, ms]) => {
      const [track, by] = k.split('\u0000');
      return { track, artist: by, ms };
    });
}

export function daySummary(data, day, artist = null) {
  const hours = new Float32Array(24);
  const byArtist = new Map();
  const byTrack = new Map();
  let ms = 0;
  for (let h = 0; h < 24; h++) {
    for (const r of data.cells[day * 24 + h]) {
      if (artist && r.artist !== artist) continue;
      hours[h] += r.ms / 60000;
      ms += r.ms;
      byArtist.set(r.artist, (byArtist.get(r.artist) || 0) + r.ms);
      const k = r.track + '\u0000' + r.artist;
      byTrack.set(k, (byTrack.get(k) || 0) + r.ms);
    }
  }
  const topArtist = [...byArtist].sort((a, b) => b[1] - a[1])[0];
  const topTrack = [...byTrack].sort((a, b) => b[1] - a[1])[0];
  return {
    ms,
    hours,
    topArtist: topArtist ? { name: topArtist[0], ms: topArtist[1] } : null,
    topTrack: topTrack ? { track: topTrack[0].split('\u0000')[0], artist: topTrack[0].split('\u0000')[1] } : null,
  };
}
