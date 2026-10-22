import { unzipSync, strFromU8 } from 'fflate';

export const TOP_N = 8;
export const PALETTE = ['#e8604c', '#e9b04f', '#a9c98f', '#3fa59c', '#6f93d8', '#a68bd8', '#e290b1', '#e6dccb'];
export const OTHER_COLOR = '#3b3c45';

// ---------- reading Spotify exports ----------

const HISTORY_RE = /(StreamingHistory|Streaming_History_Audio)[^/]*\.json$/i;

// Accepts the zip Spotify emails you, or the JSON files inside it.
// Handles both "Account data" (StreamingHistory*.json) and
// "Extended streaming history" (Streaming_History_Audio_*.json).
export async function readFiles(files, onProgress = () => {}) {
  const basic = [];
  const extended = [];
  let done = 0;
  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.zip')) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = unzipSync(buf, { filter: (f) => HISTORY_RE.test(f.name) });
        const parts = Object.values(entries);
        parts.forEach((data, i) => {
          collect(strFromU8(data), basic, extended);
          onProgress(i + 1, parts.length);
        });
      } else if (lower.endsWith('.json')) {
        collect(await file.text(), basic, extended);
      }
    } catch (err) {
      console.warn('Skipping', file.name, err);
    }
    if (!file.name.toLowerCase().endsWith('.zip')) onProgress(++done, files.length);
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
// Whole local days between two dates, ignoring DST shifts.
const dayDiff = (a, b) =>
  Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);

// A period is what gets pressed onto one record: a calendar year, or the
// rolling twelve months up to the last play (which is what Spotify's quick
// "Account data" export covers).
export function yearPeriod(year) {
  return { id: String(year), label: String(year), short: String(year), year, start: new Date(year, 0, 1), days: isLeap(year) ? 366 : 365 };
}

export function dateAt(data, d) {
  return new Date(data.start.getFullYear(), data.start.getMonth(), data.start.getDate() + d);
}

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

export function listPeriods(records) {
  const periods = listYears(records).map((y) => ({ ...yearPeriod(y.year), ms: y.ms }));
  if (!records.length) return periods;
  let first = Infinity;
  let last = -Infinity;
  for (const r of records) {
    if (r.t < first) first = r.t;
    if (r.t > last) last = r.t;
  }
  const end = new Date(last);
  // Only worth offering when it differs from a calendar year.
  if (end.getMonth() !== 11 || end.getDate() !== 31) {
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364);
    const short = `${String(start.getFullYear()).slice(2)}/${String(end.getFullYear()).slice(2)}`;
    let ms = 0;
    for (const r of records) if (r.t >= start.getTime()) ms += r.ms;
    periods.push({ id: 'last12', label: 'Last 12 months', short, start, days: 365, ms, spanDays: dayDiff(new Date(first), end) });
  }
  return periods;
}

// Short exports (about a year) read best as one rolling record; longer
// histories default to the most recent full-ish calendar year.
export function pickPeriod(periods) {
  const rolling = periods.find((p) => p.id === 'last12');
  if (rolling && rolling.spanDays <= 400) return rolling;
  const years = periods.filter((p) => p.id !== 'last12');
  const year = pickYear(years.map((p) => ({ year: p.year, ms: p.ms })));
  return years.find((p) => p.year === year);
}

export function buildYear(records, year) {
  return buildPeriod(records, yearPeriod(year));
}

export function buildPeriod(records, period) {
  const { days, start } = period;
  const year = period.year ?? null;
  const N = days * 24;
  const cells = Array.from({ length: N }, () => []);
  const artistTotals = new Map();
  const tracks = new Set();
  let totalMs = 0;
  let plays = 0;

  for (const r of records) {
    const d = new Date(r.t);
    const day = dayDiff(start, d);
    if (day < 0 || day >= days) continue;
    cells[day * 24 + d.getHours()].push(r);
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
    year, start, label: period.label, short: period.short, periodId: period.id,
    days, N, cells, minutes, topOf, perArtist, dayMs, top, topIndex, artists,
    totalMs, plays, artistCount: artists.length, trackCount: tracks.size, busiestDay,
  };
}

// Minutes per cell for any one artist, for soloing artists outside the top list.
export function artistMinutes(data, name) {
  const out = new Float32Array(data.N);
  for (let i = 0; i < data.N; i++) {
    for (const r of data.cells[i]) if (r.artist === name) out[i] += r.ms / 60000;
  }
  return out;
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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Fun facts for the liner notes card.
export function linerNotes(data) {
  const { cells, days, dayMs, totalMs } = data;
  const trackMs = new Map();
  const trackPlays = new Map();
  const weekdayMs = new Float64Array(7);
  const weekdayCount = new Float64Array(7);
  const monthMs = new Float64Array(12);
  let night = 0;
  let first = null;
  let loop = null;

  for (let d = 0; d < days; d++) {
    const date = dateAt(data, d);
    weekdayMs[date.getDay()] += dayMs[d];
    weekdayCount[date.getDay()]++;
    monthMs[date.getMonth()] += dayMs[d];
    const today = new Map();
    for (let h = 0; h < 24; h++) {
      for (const r of cells[d * 24 + h]) {
        if (!first || r.t < first.t) first = r;
        if (h < 5) night += r.ms;
        const k = r.track + '\u0000' + r.artist;
        trackMs.set(k, (trackMs.get(k) || 0) + r.ms);
        if (r.ms < 30000) continue;
        trackPlays.set(k, (trackPlays.get(k) || 0) + 1);
        const n = (today.get(k) || 0) + 1;
        today.set(k, n);
        if (!loop || n > loop.plays) loop = { plays: n, key: k, day: d };
      }
    }
  }

  let streak = { len: 0, start: 0 };
  let run = 0;
  for (let d = 0; d < days; d++) {
    run = dayMs[d] > 0 ? run + 1 : 0;
    if (run > streak.len) streak = { len: run, start: d - run + 1 };
  }

  const split = (k) => k.split('\u0000');
  const topKey = [...trackMs].sort((a, b) => b[1] - a[1])[0]?.[0];
  const avg = [...weekdayMs].map((v, i) => v / Math.max(1, weekdayCount[i]));
  const fav = avg.indexOf(Math.max(...avg));
  const active = [...monthMs.keys()].filter((m) => monthMs[m] > 0);
  const peakMonth = active.length ? active.reduce((a, b) => (monthMs[b] > monthMs[a] ? b : a)) : -1;
  const quietMonth = active.length ? active.reduce((a, b) => (monthMs[b] < monthMs[a] ? b : a)) : -1;
  const firstDate = first && new Date(first.t);

  return {
    topTrack: topKey && { track: split(topKey)[0], artist: split(topKey)[1], plays: trackPlays.get(topKey) || 0 },
    loop: loop && loop.plays > 1 && { track: split(loop.key)[0], artist: split(loop.key)[1], plays: loop.plays, day: loop.day },
    streak,
    nightShare: totalMs ? night / totalMs : 0,
    favDay: WEEKDAYS[fav],
    favDayMs: avg[fav],
    monthMs,
    peakMonth,
    quietMonth,
    first: first && {
      track: first.track,
      artist: first.artist,
      day: dayDiff(data.start, firstDate),
      time: firstDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    },
  };
}

// ---------- demo listener ----------

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD_A = ['Glass', 'Paper', 'Neon', 'Slow', 'Golden', 'Quiet', 'Electric', 'Velvet', 'Midnight', 'Hollow',
  'Silver', 'Lucky', 'Northern', 'Soft', 'Wild', 'Summer', 'Winter', 'Coastal', 'Faded', 'Bright', 'Lonely', 'Copper',
  'Sleepy', 'Cherry', 'Distant', 'Tiny'];
const WORD_B = ['Season', 'Hearts', 'Signal', 'Motel', 'Garden', 'Satellite', 'Tides', 'Avenue', 'Parade', 'Fever',
  'Weather', 'Ghosts', 'Lanterns', 'Highway', 'Rooms', 'Machines', 'Daydream', 'Echoes', 'Kingdom', 'Postcards',
  'Orchard', 'Skyline', 'Ferris Wheel', 'Telephone', 'Swimming Pool', 'Planets'];
const TAIL_A = ['Crystal', 'Sunday', 'Arcade', 'Hollow', 'Cardboard', 'Moon', 'Static', 'Velour', 'Pocket', 'Tangerine',
  'Laser', 'Honey', 'Ivory', 'Cosmic', 'Rust'];
const TAIL_B = ['Engines', 'Pines', 'Ghosts', 'Kids', 'Bloom', 'Motel', 'Club', 'Wolves', 'Society', 'Radio', 'Twins',
  'Department', 'Hotel', 'Parade', 'Fax'];

// name, weight, peak month (0-11), spread in months
const HEADLINERS = [
  ['Neon Harbor', 1.0, 0.5, 2.2],
  ['Velvet Static', 0.95, 6.3, 1.5],
  ['The Paper Moons', 0.8, 3.2, 1.8],
  ['Kaito Rain', 0.85, 9.4, 1.3],
  ['Marisol Vey', 0.6, 6, 6],
  ['Lumen', 0.55, 10.4, 0.9],
  ['Saltwater Choir', 0.5, 7, 1.0],
  ['Glasshouse Dogs', 0.5, 4.6, 1.4],
  ['Juniper & the Fog', 0.45, 11.4, 1.0],
  ['DJ Moth', 0.4, 8, 4],
  ['Low Orbit', 0.38, 1.5, 5],
];

const WEEKDAY = [8, 3, 0, 0, 0, 0, 2, 18, 40, 22, 14, 12, 20, 14, 12, 14, 18, 38, 30, 20, 28, 36, 34, 20];
const WEEKEND = [26, 18, 8, 2, 0, 0, 0, 0, 0, 4, 14, 22, 26, 30, 34, 30, 28, 24, 20, 22, 30, 38, 40, 34];

export function demoRecords(year = 2025) {
  const rnd = mulberry32(1022);
  const pick = (arr) => arr[(rnd() * arr.length) | 0];

  const makeTracks = (n) => {
    const out = new Set();
    while (out.size < n) {
      const a = pick(WORD_A);
      const b = pick(WORD_B);
      const r = rnd();
      out.add(r < 0.55 ? `${a} ${b}` : r < 0.7 ? `The ${a} ${b}` : r < 0.82 ? `${b} (Reprise)` : r < 0.92 ? `${a} ${b}, Pt. II` : `${b}`);
    }
    return [...out];
  };

  const artists = HEADLINERS.map(([name, w, peak, spread]) => ({ name, w, peak, spread, tracks: makeTracks(9 + ((rnd() * 10) | 0)) }));
  const tailNames = new Set();
  while (tailNames.size < 170) tailNames.add(`${rnd() < 0.4 ? 'The ' : ''}${pick(TAIL_A)} ${pick(TAIL_B)}`);
  for (const name of tailNames) {
    if (artists.some((a) => a.name === name)) continue;
    artists.push({ name, w: 0.001 + Math.pow(rnd(), 4) * 0.03, peak: rnd() * 12, spread: 1 + rnd() * 5, tracks: makeTracks(2 + ((rnd() * 4) | 0)) });
  }
  const idx = Object.fromEntries(artists.map((a, i) => [a.name, i]));

  const records = [];
  const days = isLeap(year) ? 366 : 365;
  const weights = new Float64Array(artists.length);

  for (let day = 0; day < days; day++) {
    const date = new Date(year, 0, 1 + day);
    const month = date.getMonth() + date.getDate() / 31;
    const dow = date.getDay();
    let weekend = dow === 0 || dow === 6;

    let dayFactor = 0.8 + rnd() * 0.4;
    if (rnd() < 0.07) dayFactor = 0.2;
    const lostHeadphones = day >= 95 && day <= 102;
    const roadTrip = day >= 196 && day <= 210;
    const crunch = day >= 305 && day <= 320;
    const holidays = day >= 355;
    if (lostHeadphones) dayFactor = 0.04;
    if (roadTrip) { dayFactor = 1.6; weekend = true; }
    if (crunch) dayFactor *= 1.15;

    for (let i = 0; i < artists.length; i++) {
      const a = artists[i];
      let dist = Math.abs(month - a.peak);
      dist = Math.min(dist, 12 - dist);
      weights[i] = a.w * (0.08 + 3 * Math.exp(-(dist * dist) / (2 * a.spread * a.spread)));
    }
    if (roadTrip) { weights[idx['Saltwater Choir']] *= 3; weights[idx['Velvet Static']] *= 2; }
    if (holidays) weights[idx['Juniper & the Fog']] *= 3;

    const curve = weekend ? WEEKEND : WEEKDAY;
    let prev = -1;
    // most days have an artist you keep coming back to
    let mood = 0;
    {
      let total = 0;
      for (const x of weights) total += x;
      let r = rnd() * total;
      while (r > weights[mood] && mood < weights.length - 1) r -= weights[mood++];
      if (mood >= HEADLINERS.length) mood = (rnd() * HEADLINERS.length) | 0;
    }
    for (let h = 0; h < 24; h++) {
      let expected = curve[h];
      if (crunch && (h <= 2 || h >= 22)) expected += 25;
      let mins = expected * dayFactor * (0.35 + rnd() * 0.75);
      if (rnd() < 0.18) mins = 0;
      mins = Math.min(58, mins);
      if (mins < 2) continue;

      const w = Float64Array.from(weights);
      const focus = !weekend && h >= 9 && h <= 16;
      if (focus || crunch) w[idx['Lumen']] *= crunch ? 6 : 3;
      if (weekend && (h >= 22 || h <= 2)) w[idx['DJ Moth']] *= 4;
      let total = 0;
      for (const x of w) total += x;

      const hourStart = new Date(year, 0, 1 + day, h).getTime();
      let t = hourStart + rnd() * 180000;
      let elapsed = 0;
      while (elapsed < mins * 60000 && t < hourStart + 3600000) {
        let ai = prev;
        const roll = rnd();
        if (roll < 0.5) ai = mood;
        else if (ai < 0 || roll > 0.75) {
          let r = rnd() * total;
          ai = 0;
          while (r > w[ai] && ai < w.length - 1) r -= w[ai++];
        }
        prev = ai;
        const a = artists[ai];
        const track = a.tracks[Math.floor(a.tracks.length * Math.pow(rnd(), 1.5))];
        const ms = rnd() < 0.1 ? 4000 + rnd() * 25000 : 140000 + rnd() * 130000;
        records.push({ t, ms, artist: a.name, track });
        t += ms;
        elapsed += ms;
      }
    }
  }
  return records;
}
