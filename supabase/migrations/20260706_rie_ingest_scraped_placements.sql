-- ============================================================================
-- RIE Phase 1.1 — Ingest the SCRAPED placement data the Phase 1 backfill missed
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--   The Phase 1 backfill (20260705_relationship_intelligence_engine.sql) only
--   counted a "placement" when a pitch_log row was explicitly marked placed
--   (pl.placed IS TRUE OR pl.placement_status = 'placed'). But Fendi's real
--   placements were SCRAPED, never pitched, so they live in two places the
--   Phase 1 backfill never read as placements:
--
--     BLOCK A — Spotify warm placements: playlist_targets rows tagged
--               research_context->>'source' IN
--               ('spotify_placement','spotify_for_artists_csv').
--               Phase 1 ingested these as 'discovered' only (§5c), so
--               is_supporter stayed false.
--
--     BLOCK B — Apple radio spins: apple_station_plays (song -> station) and
--               radio_targets. Phase 1 explicitly DEFERRED this ("template
--               today, not a populated feed").
--
-- SAFETY / IDEMPOTENCY
--   * Additive only. Does NOT alter or delete any existing rows/objects.
--   * relationship_history inserts reuse the Phase 1 guard
--       ON CONFLICT (source, source_id, event_type) DO NOTHING
--     so re-running (alongside or after the Phase 1 backfill) is a no-op.
--   * relationships inserts use ON CONFLICT (dedupe_key) DO NOTHING so they
--     never clobber the richer Phase 1 rollup — they only fill gaps.
--   * relationship_stations has no unique constraint, so its insert is guarded
--     with NOT EXISTS on (relationship_id, station_id).
--
-- APPLY: paste into the Lovable SQL editor and run AFTER the Phase 1 migration.
--        Safe / idempotent to re-run.
-- ============================================================================


-- ############################################################################
-- BLOCK A — Spotify warm placements (playlist_targets -> relationships/history)
-- ############################################################################

-- A1) Ensure a relationships record exists for every warm curator.
--     Same dedupe_key logic as Phase 1 §5a; DO NOTHING so we never overwrite the
--     richer full-catalog rollup when the Phase 1 backfill has already run.
INSERT INTO public.relationships AS r (
  relationship_type, platform, dedupe_key, spotify_owner_id,
  name, email, instagram, tiktok, website,
  genres, audience_size, last_active, confidence_score
)
SELECT
  'spotify_curator'::public.relationship_type,
  'spotify',
  s.dk,
  max(s.spotify_owner_id),
  max(s.curator_name),
  max(s.curator_email),
  max(s.curator_instagram),
  max(s.curator_tiktok),
  COALESCE(max(s.curator_website), max(s.curator_linktree)),
  array_remove(array_agg(DISTINCT s.lane), NULL),
  max(s.follower_count),
  max(s.updated_at),
  max(s.contact_confidence)
FROM (
  SELECT
    COALESCE(
      NULLIF(pt.research_context->>'spotify_owner_id', ''),
      'email:' || lower(NULLIF(pt.curator_email, '')),
      'ig:'    || lower(NULLIF(pt.curator_instagram, '')),
      'name:'  || lower(NULLIF(pt.curator_name, '')),
      'playlist:' || pt.playlist_id
    ) AS dk,
    NULLIF(pt.research_context->>'spotify_owner_id', '') AS spotify_owner_id,
    pt.curator_name, pt.curator_email, pt.curator_instagram, pt.curator_tiktok,
    pt.curator_website, pt.curator_linktree, pt.lane, pt.follower_count,
    pt.updated_at, pt.contact_confidence
  FROM public.playlist_targets pt
  WHERE pt.research_context->>'source' IN ('spotify_placement','spotify_for_artists_csv')
) s
GROUP BY s.dk
ON CONFLICT (dedupe_key) DO NOTHING;

-- A2) Emit a 'placement' event per warm playlist_targets row.
--     song = coalesce(featuring_tracks, playlist_name). Joins relationships by the
--     same dedupe_key expression. (source, source_id, event_type) =
--     ('playlist_targets', pt.id, 'placement') is distinct from the Phase 1
--     'discovered' event on the same row, so there is no collision.
INSERT INTO public.relationship_history (
  relationship_id, event_type, source, source_id, occurred_at,
  playlist_id, playlist_name, song, num_additions, catalog_placements
)
SELECT
  r.id, 'placement', 'playlist_targets', pt.id::text,
  COALESCE(pt.updated_at, pt.created_at, now()),
  pt.playlist_id, pt.playlist_name,
  COALESCE(NULLIF(pt.research_context->>'featuring_tracks', ''), pt.playlist_name),
  1, 1
FROM public.playlist_targets pt
JOIN public.relationships r ON r.dedupe_key = COALESCE(
  NULLIF(pt.research_context->>'spotify_owner_id', ''),
  'email:' || lower(NULLIF(pt.curator_email, '')),
  'ig:'    || lower(NULLIF(pt.curator_instagram, '')),
  'name:'  || lower(NULLIF(pt.curator_name, '')),
  'playlist:' || pt.playlist_id
)
WHERE pt.research_context->>'source' IN ('spotify_placement','spotify_for_artists_csv')
ON CONFLICT (source, source_id, event_type) DO NOTHING;


-- ############################################################################
-- BLOCK B — Apple radio (radio_targets + apple_station_plays -> relationships)
-- ############################################################################

-- B1) One relationship per station. dedupe_key = 'station:'||station_id.
INSERT INTO public.relationships AS r (
  relationship_type, platform, dedupe_key,
  name, organization, email, website, territory,
  audience_size, last_active
)
SELECT
  'apple_radio_station'::public.relationship_type,
  'apple_radio',
  'station:' || rt.station_id,
  rt.station_call_sign,
  rt.station_call_sign,
  NULLIF(rt.contact_email, ''),
  NULLIF(rt.contact_url, ''),
  NULLIF(trim(BOTH ', ' FROM concat_ws(', ', NULLIF(rt.city, ''), NULLIF(rt.area_name, ''))), ''),
  rt.total_spins,
  rt.updated_at
FROM public.radio_targets rt
ON CONFLICT (dedupe_key) DO NOTHING;

-- B2) relationship_stations bridge (no unique constraint -> NOT EXISTS guard).
INSERT INTO public.relationship_stations (
  relationship_id, station_id, call_sign, station_type,
  city, area_name, country_code, timezone, total_spins, is_active
)
SELECT
  r.id, rt.station_id, rt.station_call_sign, COALESCE(rt.station_type, 'radio'),
  rt.city, rt.area_name, rt.country_code, rt.timezone,
  COALESCE(rt.total_spins, 0), true
FROM public.radio_targets rt
JOIN public.relationships r ON r.dedupe_key = 'station:' || rt.station_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.relationship_stations rs
  WHERE rs.relationship_id = r.id AND rs.station_id = rt.station_id
);

-- B3) 'placement' event per (station, song) from apple_station_plays.
--     Scoring only credits event_type='placement' (not 'spin'), so this is what
--     makes an already-playing station score as a supporter.
INSERT INTO public.relationship_history (
  relationship_id, event_type, source, source_id, occurred_at,
  station_id, song, spins, territory, frequency, num_additions, catalog_placements
)
SELECT
  r.id, 'placement', 'apple_station_plays', sp.id::text,
  COALESCE(sp.period_end::timestamptz, sp.period_start::timestamptz, sp.captured_at),
  sp.station_id, sp.song_name, sp.spins_total,
  NULLIF(trim(BOTH ', ' FROM concat_ws(', ', NULLIF(sp.city, ''), NULLIF(sp.area_name, ''))), ''),
  sp.frequency, 1, 1
FROM public.apple_station_plays sp
JOIN public.relationships r ON r.dedupe_key = 'station:' || sp.station_id
ON CONFLICT (source, source_id, event_type) DO NOTHING;

-- B4) 'spin' event per apple_station_plays row (running spin total, not scored).
INSERT INTO public.relationship_history (
  relationship_id, event_type, source, source_id, occurred_at,
  station_id, song, spins, territory, frequency
)
SELECT
  r.id, 'spin', 'apple_station_plays', sp.id::text,
  COALESCE(sp.period_end::timestamptz, sp.period_start::timestamptz, sp.captured_at),
  sp.station_id, sp.song_name, sp.spins_total,
  NULLIF(trim(BOTH ', ' FROM concat_ws(', ', NULLIF(sp.city, ''), NULLIF(sp.area_name, ''))), ''),
  sp.frequency
FROM public.apple_station_plays sp
JOIN public.relationships r ON r.dedupe_key = 'station:' || sp.station_id
ON CONFLICT (source, source_id, event_type) DO NOTHING;


-- ############################################################################
-- Recompute scores + supporter flags + outreach_status across everything.
-- ############################################################################
SELECT public.rie_recompute_scores();

-- ============================================================================
-- END RIE Phase 1.1. Verification queries live in the companion file:
--   20260706_rie_ingest_scraped_placements_VERIFY.md
-- ============================================================================
