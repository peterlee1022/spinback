import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { readFiles, listYears, pickYear, buildYear, linerNotes, artistMinutes, daySummary, listPeriods, pickPeriod, buildPeriod, dateAt } from '../src/data.js';

const json = (name, rows) => new File([JSON.stringify(rows)], name, { type: 'application/json' });

const basicRows = [
  { endTime: '2024-03-02 10:30', artistName: 'Alpha', trackName: 'One', msPlayed: 200000 },
  { endTime: '2024-03-02 10:34', artistName: 'Alpha', trackName: 'Two', msPlayed: 180000 },
  { endTime: '2024-03-03 22:10', artistName: 'Beta', trackName: 'Three', msPlayed: 240000 },
  { endTime: '2024-03-03 22:10', artistName: 'Beta', trackName: 'Skipped', msPlayed: 0 },
];

const extendedRows = [
  { ts: '2023-12-31T23:30:00Z', ms_played: 120000, master_metadata_track_name: 'Old', master_metadata_album_artist_name: 'Gamma' },
  { ts: '2024-06-01T12:00:00Z', ms_played: 200000, master_metadata_track_name: 'New', master_metadata_album_artist_name: 'Gamma' },
  { ts: '2024-06-01T12:00:00Z', ms_played: 200000, master_metadata_track_name: 'New', master_metadata_album_artist_name: 'Gamma' },
  { ts: '2024-06-02T09:00:00Z', ms_played: 600000, master_metadata_track_name: null, episode_name: 'Ep 4', episode_show_name: 'A Podcast' },
  { ts: '2024-06-02T09:30:00Z', ms_played: 1000, master_metadata_track_name: null, master_metadata_album_artist_name: null },
];

test('reads the basic Account data format and drops zero-length plays', async () => {
  const records = await readFiles([json('StreamingHistory_music_0.json', basicRows)]);
  assert.equal(records.length, 3);
  const first = records.find((r) => r.track === 'One');
  // endTime is UTC and marks the end of the play, so the start is ms earlier
  assert.equal(first.t, Date.parse('2024-03-02T10:30:00Z') - 200000);
  assert.equal(first.artist, 'Alpha');
});

test('reads extended history, keeps podcasts, skips empty rows and duplicates', async () => {
  const records = await readFiles([json('Streaming_History_Audio_2024.json', extendedRows)]);
  assert.equal(records.length, 3);
  assert.ok(records.some((r) => r.artist === 'A Podcast' && r.track === 'Ep 4'));
});

test('prefers extended history when both formats are dropped together', async () => {
  const records = await readFiles([
    json('StreamingHistory_music_0.json', basicRows),
    json('Streaming_History_Audio_2024.json', extendedRows),
  ]);
  assert.ok(records.every((r) => r.artist !== 'Alpha'));
});

test('reads history files out of the Spotify zip and ignores everything else', async () => {
  const zip = zipSync({
    'Spotify Account Data/StreamingHistory_music_0.json': strToU8(JSON.stringify(basicRows)),
    'Spotify Account Data/Userdata.json': strToU8(JSON.stringify([{ endTime: '2024-01-01 00:00', artistName: 'Nope', trackName: 'Nope', msPlayed: 1 }])),
  });
  const progress = [];
  const records = await readFiles([new File([zip], 'my_spotify_data.zip')], (done, total) => progress.push([done, total]));
  assert.equal(records.length, 3);
  assert.deepEqual(progress, [[1, 1]]);
});

test('ignores files that are not streaming history', async () => {
  const records = await readFiles([json('Playlist1.json', { playlists: [] }), new File(['not json'], 'notes.json')]);
  assert.equal(records.length, 0);
});

// Built in local time so the tests don't depend on the machine's timezone.
const at = (y, m, d, h, min = 0) => new Date(y, m, d, h, min).getTime();
const rec = (t, artist, track, ms = 180000) => ({ t, ms, artist, track });

const sample = [
  rec(at(2024, 0, 1, 0, 5), 'Alpha', 'Opener'),
  rec(at(2024, 0, 1, 0, 9), 'Alpha', 'Opener'),
  rec(at(2024, 0, 2, 13), 'Beta', 'Lunch', 600000),
  rec(at(2024, 0, 3, 13), 'Beta', 'Lunch'),
  rec(at(2024, 0, 3, 23, 50), 'Alpha', 'Late'),
  rec(at(2024, 0, 5, 8), 'Gamma', 'Commute', 20000),
  rec(at(2023, 5, 1, 12), 'Old', 'Song'),
];

test('picks the most recent year with a decent amount of listening', () => {
  const years = listYears(sample);
  assert.deepEqual(years.map((y) => y.year), [2023, 2024]);
  assert.equal(pickYear(years), 2024);
});

test('buckets plays into day and hour cells', () => {
  const d = buildYear(sample, 2024);
  assert.equal(d.days, 366);
  assert.equal(d.N, 366 * 24);
  assert.equal(d.minutes[0 * 24 + 0], 6);
  assert.equal(d.minutes[1 * 24 + 13], 10);
  assert.equal(d.minutes[2 * 24 + 23], 3);
  // plays under 30 seconds count toward time but not the play count
  assert.equal(d.plays, 5);
  assert.equal(d.top[0].name, 'Beta');
  assert.equal(d.busiestDay, 1);
  assert.equal(d.topOf[0], d.topIndex.get('Alpha'));
});

test('summarises a day and any single artist', () => {
  const d = buildYear(sample, 2024);
  const day = daySummary(d, 2);
  assert.equal(day.ms, 360000);
  assert.equal(daySummary(d, 2, 'Alpha').ms, 180000);
  const gamma = artistMinutes(d, 'Gamma');
  assert.equal(gamma.reduce((a, b) => a + b, 0).toFixed(3), (20000 / 60000).toFixed(3));
});

test('liner notes find the streak, the song on loop and the first song', () => {
  const n = linerNotes(buildYear(sample, 2024));
  assert.deepEqual(n.streak, { len: 3, start: 0 });
  assert.equal(n.loop.track, 'Opener');
  assert.equal(n.loop.plays, 2);
  assert.equal(n.first.track, 'Opener');
  assert.equal(n.topTrack.track, 'Lunch');
  assert.ok(n.nightShare > 0);
});

test('offers a rolling 12 months that ends on the last play', () => {
  const records = [rec(at(2025, 10, 3, 9), 'Alpha', 'Early'), rec(at(2026, 9, 21, 20), 'Beta', 'Late')];
  const periods = listPeriods(records);
  assert.deepEqual(periods.map((p) => p.id), ['2025', '2026', 'last12']);
  const rolling = periods.find((p) => p.id === 'last12');
  assert.equal(rolling.short, '25/26');
  assert.equal(dateAt({ start: rolling.start }, 364).getDate(), 21);
  // about a year of history, like Spotify's Account data export, defaults to the rolling view
  assert.equal(pickPeriod(periods).id, 'last12');
  const d = buildPeriod(records, rolling);
  assert.equal(d.days, 365);
  assert.equal(d.minutes[364 * 24 + 20], 3);
  assert.equal(d.year, null);
});

test('long histories default to a calendar year and skip the rolling view when it ends on Dec 31', () => {
  const records = [rec(at(2020, 2, 1, 9), 'Alpha', 'Old'), rec(at(2024, 11, 31, 20), 'Beta', 'New')];
  const periods = listPeriods(records);
  assert.ok(!periods.some((p) => p.id === 'last12'));
  assert.equal(pickPeriod(periods).id, '2024');
});
