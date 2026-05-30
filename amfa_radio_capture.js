/**
 * Apple Music for Artists — weekly radio-spins capture → Fan Fuel Hub
 *
 * 1. Log into https://artists.apple.com (any Measure page for your artist).
 * 2. Set HUB_KEY to your FANFUEL_HUB_KEY (same as Supabase edge secret).
 * 3. Paste this entire file into the browser console on that tab.
 *
 * Fetches catalog songs, then per-song station KPI (breakout=station), POSTs to
 * control-center-api action ingest_apple_spins.
 *
 * API shapes verified 2026-05-30 — see supabase/migrations/20260530_apple_radio_growth.sql
 */
(function amfaRadioCapture() {
  const HUB_KEY = 'PASTE_FANFUEL_HUB_KEY_HERE';
  const CCA =
    'https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api';
  /** Set if auto-detect fails (ami:identity:...) */
  const ARTIST_ID_OVERRIDE = '';
  const CONCURRENCY = 4;
  const DELAY_MS = 120;

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function getJson(url) {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  function mondayOf(d = new Date()) {
    const dt = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
    const day = dt.getUTCDay();
    dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return dt.toISOString().slice(0, 10);
  }

  async function resolveArtistId() {
    if (ARTIST_ID_OVERRIDE) return ARTIST_ID_OVERRIDE.trim();
    const path = decodeURIComponent(location.pathname + location.search);
    const fromUrl = path.match(/ami:identity:[^\s&/]+/);
    if (fromUrl) return fromUrl[0];
    for (const ep of [
      '/api/measure/me',
      '/api/measure/session',
      '/api/measure/artists',
    ]) {
      try {
        const j = await getJson(ep);
        const id =
          j?.artistId ||
          j?.artist?.id ||
          j?.identityId ||
          (Array.isArray(j?.artists) && j.artists[0]?.id);
        if (id && String(id).includes('ami:')) return String(id);
      } catch (_) {
        /* try next */
      }
    }
    throw new Error(
      'Could not resolve artist_id — open a Measure page for your artist or set ARTIST_ID_OVERRIDE.',
    );
  }

  async function loadSongs(artistId) {
    const url = `/api/measure/catalog/${encodeURIComponent(artistId)}/songs`;
    const j = await getJson(url);
    const list = j?.songs || j?.data || j?.results || j;
    if (!Array.isArray(list)) throw new Error('Unexpected catalog /songs response');
    return list
      .map((s) => ({
        song_id: String(s.contentGroupId || s.id || s.songId),
        song_name: s.contentGroupName || s.name || s.title || null,
      }))
      .filter((s) => s.song_id);
  }

  function mapKpiRow(song, row) {
    const result = row.result || row;
    const meta = result.meta || row.meta || {};
    const station = meta.station || {};
    const geo = meta.geo || {};
    const spins = Number(result.kpiTotal ?? row.kpiTotal ?? 0);
    if (!spins) return null;
    const station_id = station.id != null ? String(station.id) : '';
    if (!station_id) return null;
    return {
      song_id: String(result.query?.song || row.query?.song || song.song_id),
      song_name: song.song_name,
      station_id,
      call_sign: station.callSign ?? station.call_sign ?? null,
      band: station.band ?? null,
      frequency: station.frequency ?? null,
      timezone: station.timezone ?? null,
      city: geo.name ?? geo.city ?? null,
      area: geo.areaName ?? geo.area ?? null,
      country: geo.countryCode ?? geo.country ?? null,
      latitude: geo.latitude ?? null,
      longitude: geo.longitude ?? null,
      geo_id: geo.id != null ? String(geo.id) : null,
      spins,
    };
  }

  async function fetchSongStations(artistId, song) {
    const qs = new URLSearchParams({
      breakout: 'station',
      song: song.song_id,
      metric: 'RADIO_SPINS',
      artist: artistId,
    });
    const j = await getJson(`/api/measure/stats/kpi?${qs}`);
    const rows = j?.results || j?.data || (Array.isArray(j) ? j : []);
    let period_start = j?.startDate || j?.kpi?.startDate || null;
    let period_end = j?.endDate || j?.kpi?.endDate || null;
    const plays = [];
    for (const row of rows) {
      const kpi = row.kpi || row;
      if (kpi?.startDate) period_start = kpi.startDate;
      if (kpi?.endDate) period_end = kpi.endDate;
      const mapped = mapKpiRow(song, row);
      if (mapped) plays.push(mapped);
    }
    return { plays, period_start, period_end };
  }

  async function ingest(payload) {
    const r = await fetch(CCA, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': HUB_KEY,
      },
      body: JSON.stringify({ action: 'ingest_apple_spins', ...payload }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`ingest ${r.status}: ${text}`);
    return JSON.parse(text);
  }

  async function main() {
    if (!HUB_KEY || HUB_KEY.includes('PASTE')) {
      throw new Error('Set HUB_KEY to your FANFUEL_HUB_KEY before running.');
    }
    console.log('[amfa] resolving artist…');
    const artist_id = await resolveArtistId();
    console.log('[amfa] artist', artist_id);
    const songs = await loadSongs(artist_id);
    console.log(`[amfa] ${songs.length} songs — fetching station KPIs…`);
    const allPlays = [];
    let period_start = null;
    let period_end = null;
    let done = 0;
    const queue = [...songs];

    async function worker() {
      while (queue.length) {
        const song = queue.shift();
        await sleep(DELAY_MS);
        try {
          const { plays, period_start: ps, period_end: pe } =
            await fetchSongStations(artist_id, song);
          if (ps) period_start = ps;
          if (pe) period_end = pe;
          allPlays.push(...plays);
        } catch (e) {
          console.warn(
            '[amfa] skip',
            song.song_name || song.song_id,
            e.message,
          );
        }
        done += 1;
        if (done % 25 === 0) {
          console.log(
            `[amfa] ${done}/${songs.length} songs, ${allPlays.length} play rows…`,
          );
        }
      }
    }

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => worker()),
    );

    const stations = new Set(allPlays.map((p) => p.station_id));
    const totalSpins = allPlays.reduce((s, p) => s + p.spins, 0);
    console.log(
      `[amfa] ${allPlays.length} rows, ${stations.size} stations, ${totalSpins} lifetime spins — ingesting…`,
    );

    const result = await ingest({
      artist_id,
      captured_at: new Date().toISOString(),
      snapshot_week: mondayOf(),
      period_start,
      period_end,
      plays: allPlays,
    });
    console.log('[amfa] done', result);
    return result;
  }

  return main();
})();
