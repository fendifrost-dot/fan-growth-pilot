-- Opportunity Engine — ONE real seeded example for the live Opportunity Inbox.
--
-- Purpose: after applying 20260801000000_opportunity_engine_phase1.sql, run THIS
-- in the Lovable SQL editor to place a single, coherent, REAL database row in the
-- inbox (/admin/opportunities). The inbox renders DB rows only — this is how you
-- see live data before Phase 2 discovery connectors exist. It is NOT auto-applied
-- (it lives under supabase/seed/, not supabase/migrations/), so production is only
-- seeded when you deliberately run it. Idempotent; safe to re-run; easy to remove
-- (delete where dedupe_key = the value below).
--
-- The score components below are exactly what src/lib/opportunities/scoring.ts
-- produces for scoreInput { audienceFit:0.9, audienceSize:50000, warmth:0.4,
-- historicConversion:0.15, effort:0.35, risk:0.1, valueCeiling:800, hasContact:true }
-- (verified via `deno eval` against the scorer) — these are honest numbers, not
-- decorative placeholders.

do $$
declare
  v_song_id  uuid;
  v_entity_id uuid;
  v_opp_id   uuid;
begin
  -- 1. Song: reuse an existing 'Designed For Me' track if present, else create one.
  select id into v_song_id from public.tracks
    where lower(name) like '%designed for me%' order by created_at asc limit 1;
  if v_song_id is null then
    insert into public.tracks (name, status, duration_seconds, default_tone)
      values ('Designed For Me', 'active', 200, 'confident')
      returning id into v_song_id;
  else
    update public.tracks set duration_seconds = coalesce(duration_seconds, 200) where id = v_song_id;
  end if;

  -- 1b. Song intelligence profile (one per track).
  insert into public.song_intelligence_profiles
    (track_id, bpm, musical_key, mode, energy, genre_tags, mood_tags, source, analysis_version)
  values
    (v_song_id, 122, 'A', 'minor', 0.7, array['deep house','melodic house'],
     array['nocturnal','euphoric'], 'manual', 'seed-v1')
  on conflict (track_id) do nothing;

  -- 1c. Approved clip (validated window inside the 200s track).
  insert into public.song_clips
    (track_id, label, start_seconds, end_seconds, purpose, status)
  values
    (v_song_id, 'drop', 64, 88, 'pitch', 'approved')
  on conflict (track_id, start_seconds, end_seconds) do nothing;

  -- 2. Entity (deduped on normalized platform + external id).
  select id into v_entity_id from public.growth_entities
    where lower(platform) = 'spotify' and lower(platform_external_id) = '37iabc' limit 1;
  if v_entity_id is null then
    insert into public.growth_entities
      (entity_type, name, platform, platform_external_id, canonical_url, location, metadata)
    values
      ('playlist', 'Deep House Vibes', 'spotify', '37iABC',
       'https://open.spotify.com/playlist/37iABC', 'Global',
       jsonb_build_object('genre_tags', jsonb_build_array('deep house'),
                          'mood_tags', jsonb_build_array('euphoric')))
      returning id into v_entity_id;
  end if;

  -- 3. Opportunity, created AND scored (components = scorer output for the inputs above).
  insert into public.growth_opportunities (
    entity_id, source_platform, opportunity_type, source_url, title, why_discovered,
    discovery_evidence,
    audience_match_score, relationship_score, reach_score, response_probability,
    conversion_probability, effort_score, lifetime_value_score, risk_score,
    opportunity_score, score_version, scored_at,
    recommended_song_id, recommended_start_seconds, recommended_end_seconds,
    recommended_action, status, dedupe_key
  ) values (
    v_entity_id, 'spotify', 'playlist_pitch',
    'https://open.spotify.com/playlist/37iABC',
    'Pitch "Designed For Me" to Deep House Vibes',
    'Deep-house genre + euphoric mood match; ~50k followers; public contact available.',
    jsonb_build_object(
      'score_input', jsonb_build_object('audienceFit',0.9,'audienceSize',50000,'warmth',0.4,
        'historicConversion',0.15,'effort',0.35,'risk',0.1,'valueCeiling',800,'hasContact',true),
      'seeded_by', 'opportunity_engine_demo_seed'),
    90, 0, 67.13, 40, 6, 35, 38.30, 10,
    45.55, 'det-v1', now(),
    v_song_id, 64, 88,
    'Send a personal playlist pitch', 'new',
    lower(v_entity_id::text) || '|playlist_pitch|song:' || lower(v_song_id::text)
  )
  on conflict (dedupe_key) do nothing
  returning id into v_opp_id;

  -- If it already existed, fetch it so the events below attach correctly.
  if v_opp_id is null then
    select id into v_opp_id from public.growth_opportunities
      where dedupe_key = lower(v_entity_id::text) || '|playlist_pitch|song:' || lower(v_song_id::text);
  end if;

  -- 4. One recorded action + a relationship event, so the row shows a live history.
  insert into public.opportunity_actions (opportunity_id, action_type, actor_kind, detail)
    values (v_opp_id, 'note', 'service',
            jsonb_build_object('note', 'Seeded example opportunity for the live inbox.'));

  insert into public.growth_relationship_events
    (entity_id, opportunity_id, event_type, direction, channel, weight, source, source_id)
  values
    (v_entity_id, v_opp_id, 'discovered', 'system', 'seed', 1, 'seed', v_opp_id::text)
  on conflict (source, source_id, event_type) do nothing;

  raise notice 'Seeded opportunity % (entity %, song %)', v_opp_id, v_entity_id, v_song_id;
end $$;
