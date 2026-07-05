-- ============================================================================
-- Relationship Intelligence Engine (RIE) — Phase 1
-- Data model + ingestion (backfill) + relationship scoring v1
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
--   A persistent CRM / memory layer whose primary entity is the PERSON or
--   ORGANIZATION that has already shown interest in the catalog (a Spotify
--   curator today; radio stations / DJs / blogs / creators tomorrow). One
--   curator owns many playlists; everything rolls up into ONE relationship
--   profile. This COMPLEMENTS the discovery engine — warm relationships get
--   exhausted before discovery runs.
--
-- DESIGN RULES (enforced here)
--   * The relationship (person/org) is the primary entity, NOT the playlist.
--   * relationship_type is an ENUM so future source types fit one model.
--   * relationship_history is APPEND-ONLY — we never overwrite past activity.
--     Ingestion is idempotent via UNIQUE(source, source_id, event_type).
--   * Additive only. Reads existing tables; does not alter playlist_targets,
--     pitch_log, follower_snapshots, or the radio tables.
--   * Access is service-role only (edge functions), mirroring playlist_targets
--     — deny anon AND authenticated direct access (no per-row user_id).
--
-- INGESTION SOURCES ACTUALLY AVAILABLE TODAY (honest accounting)
--   * playlist_targets      -> relationships + relationship_playlists + history
--   * pitch_log             -> history (pitch_sent / reply / placement)
--   * follower_snapshots    -> retention/growth signal for scoring
--   NOT YET AVAILABLE (schema built, ingestion DEFERRED — needs a data source):
--   * radio spins (relationship_stations / relationship_shows). Apple Music
--     for Artists spin data (apple_station_plays) is a template today, not a
--     populated feed, so we model it but ingest nothing. Flagged below.
--
-- APPLY: paste into the Lovable SQL editor and run. Safe / idempotent to re-run.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0) ENUMS — future-proof the relationship taxonomy up front.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.relationship_type AS ENUM (
    'spotify_curator',
    'apple_radio_station',
    'radio_dj',
    'college_radio',
    'terrestrial_radio',
    'internet_radio',
    'blog',
    'press',
    'youtube',
    'tiktok',
    'instagram',
    'twitch',
    'podcast',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.relationship_event_type AS ENUM (
    'discovered',        -- first time we saw this supporter (from playlist_targets.created_at)
    'playlist_add',      -- a song of ours was added to a playlist
    'playlist_remove',   -- a song of ours was removed
    'pitch_sent',        -- we reached out
    'reply',             -- they replied
    'placement',         -- confirmed placement (song added & confirmed)
    'spin',              -- radio spin (deferred: needs a spin data source)
    'follower_snapshot', -- audience size captured (kept in follower_snapshots; here for manual notes)
    'mention'            -- press / social mention (future)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ----------------------------------------------------------------------------
-- 1) relationships — THE CRM ENTITY (person / organization).
--    dedupe_key is the identity rollup key (conservative: owner_id, else exact
--    email, else exact IG, else exact normalized name, else the playlist id so
--    nothing is ever orphaned). Fuzzy name merging is intentionally NOT done.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.relationships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_type public.relationship_type NOT NULL DEFAULT 'spotify_curator',
  name              text,
  organization      text,
  platform          text,                     -- spotify | apple_radio | ...
  website           text,
  email             text,
  instagram         text,
  tiktok            text,
  youtube           text,
  facebook          text,
  linkedin          text,
  contact_form      text,
  territory         text,
  genres            text[] DEFAULT '{}',
  audience_size     integer,
  last_active       timestamptz,
  confidence_score  smallint,                 -- contact/identity confidence 1..10 (from contact_confidence)
  relationship_score integer NOT NULL DEFAULT 0, -- 0..100, computed by rie_recompute_scores()
  is_supporter      boolean NOT NULL DEFAULT false, -- true once any confirmed placement exists
  outreach_status   text NOT NULL DEFAULT 'not_contacted', -- not_contacted|contacted|replied|supporter
  last_contact      timestamptz,
  last_reply        timestamptz,
  notes             text,
  spotify_owner_id  text,                      -- stable Spotify identity when known
  dedupe_key        text NOT NULL,             -- identity rollup key (see above)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relationships_dedupe_key_uniq UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_relationships_type       ON public.relationships (relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_score      ON public.relationships (relationship_score DESC);
CREATE INDEX IF NOT EXISTS idx_relationships_supporter  ON public.relationships (is_supporter) WHERE is_supporter;
CREATE INDEX IF NOT EXISTS idx_relationships_owner       ON public.relationships (spotify_owner_id);
CREATE INDEX IF NOT EXISTS idx_relationships_genres     ON public.relationships USING gin (genres);

DROP TRIGGER IF EXISTS set_relationships_updated_at ON public.relationships;
CREATE TRIGGER set_relationships_updated_at
  BEFORE UPDATE ON public.relationships
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- ----------------------------------------------------------------------------
-- 2) CHILD ASSET TABLES — assets a relationship owns.
--    relationship_playlists is a thin bridge to playlist_targets (populated).
--    relationship_stations / relationship_shows model the radio hierarchy
--    (station -> program/show -> DJ). Schema built now; ingestion DEFERRED.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.relationship_playlists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id  uuid NOT NULL REFERENCES public.relationships(id) ON DELETE CASCADE,
  playlist_id      text NOT NULL REFERENCES public.playlist_targets(playlist_id) ON DELETE CASCADE,
  playlist_name    text,
  follower_count   integer,
  genre            text,                       -- coarse lane bucket from playlist_targets.lane
  first_discovered timestamptz,                -- playlist_targets.created_at (immutable)
  last_seen        timestamptz,                -- playlist_targets.updated_at
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relationship_playlists_playlist_uniq UNIQUE (playlist_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_playlists_rel ON public.relationship_playlists (relationship_id);

CREATE TABLE IF NOT EXISTS public.relationship_stations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id  uuid NOT NULL REFERENCES public.relationships(id) ON DELETE CASCADE,
  station_id       text,                       -- -> radio_targets.station_id (deferred link)
  call_sign        text,
  station_type     text,                       -- radio | dj | club | internet | college
  city             text,
  area_name        text,
  country_code     text,
  band             text,
  frequency        text,
  timezone         text,
  total_spins      integer DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rel_stations_rel     ON public.relationship_stations (relationship_id);
CREATE INDEX IF NOT EXISTS idx_rel_stations_station ON public.relationship_stations (station_id);

CREATE TABLE IF NOT EXISTS public.relationship_shows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id  uuid NOT NULL REFERENCES public.relationships(id) ON DELETE CASCADE,
  station_ref      uuid REFERENCES public.relationship_stations(id) ON DELETE CASCADE,
  show_name        text,
  dj_name          text,
  schedule         text,                       -- freeform ("Fri 8pm", weekly, etc.)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rel_shows_rel     ON public.relationship_shows (relationship_id);
CREATE INDEX IF NOT EXISTS idx_rel_shows_station ON public.relationship_shows (station_ref);


-- ----------------------------------------------------------------------------
-- 3) relationship_history — APPEND-ONLY event log. Never overwritten.
--    Idempotent ingestion: UNIQUE(source, source_id, event_type) means a source
--    row can emit at most one event of each type, and re-running is a no-op.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.relationship_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id    uuid NOT NULL REFERENCES public.relationships(id) ON DELETE CASCADE,
  event_type         public.relationship_event_type NOT NULL,
  source             text NOT NULL,            -- playlist_targets | pitch_log | follower_snapshots | apple_station_plays | manual
  source_id          text,                     -- id of the originating row (for idempotency)
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  -- playlist / placement fields
  playlist_id        text,
  playlist_name      text,
  song               text,                     -- track name
  songs_added        jsonb DEFAULT '[]'::jsonb,
  num_additions      integer DEFAULT 0,
  num_removals       integer DEFAULT 0,
  catalog_placements integer DEFAULT 0,        -- confirmed placements from this event
  lifetime_value     numeric DEFAULT 0,        -- optional $ / value attribution (future)
  -- radio fields (deferred population)
  station_id         text,
  show               text,
  dj                 text,
  spins              integer,
  territory          text,
  frequency          text,
  -- flexible overflow
  payload            jsonb DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relationship_history_idem UNIQUE (source, source_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_rel_history_rel      ON public.relationship_history (relationship_id);
CREATE INDEX IF NOT EXISTS idx_rel_history_type     ON public.relationship_history (event_type);
CREATE INDEX IF NOT EXISTS idx_rel_history_occurred ON public.relationship_history (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_rel_history_playlist ON public.relationship_history (playlist_id);


-- ----------------------------------------------------------------------------
-- 4) SCORING v1 — a single 0..100 relationship_score from available signals.
--
--    Pure scalar function holds the documented formula (one testable place).
--    STABLE (not IMMUTABLE) because recency reads now().
--
--    WEIGHTS (sum = 1.00):
--      0.35  placement   1 song placed = 0.6, 2+ = 1.0   (strongest signal)
--      0.15  reply        replied once = 0.6, 2+ = 1.0
--      0.15  retention    follower growth across their playlists, 0..1
--      0.10  genre_match  1.0 if we have a genre/lane for them (they were
--                         discovered FOR our lane), else 0.5 neutral. NOTE:
--                         true catalog similarity is the later "similar-song
--                         intelligence" phase; this is the v1 proxy.
--      0.10  audience     ln(followers)/ln(1e6), clamped 0..1
--      0.10  recency      linear decay: 1.0 today -> 0 at 365d since last_active
--      0.05  confidence   contact_confidence / 10
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rie_relationship_score(
  p_placements  integer,      -- distinct songs with a confirmed placement
  p_replies     integer,      -- reply events
  p_retention   numeric,      -- 0..1 follower-growth signal
  p_genre_match numeric,      -- 0..1
  p_audience    integer,      -- audience size (followers)
  p_last_active timestamptz,
  p_confidence  integer       -- 1..10
) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT round(100 * greatest(0, least(1,
        0.35 * (CASE WHEN COALESCE(p_placements,0) >= 2 THEN 1.0
                     WHEN COALESCE(p_placements,0) = 1 THEN 0.6 ELSE 0 END)
      + 0.15 * (CASE WHEN COALESCE(p_replies,0) >= 2 THEN 1.0
                     WHEN COALESCE(p_replies,0) = 1 THEN 0.6 ELSE 0 END)
      + 0.15 * COALESCE(p_retention, 0)
      + 0.10 * COALESCE(p_genre_match, 0)
      + 0.10 * (CASE WHEN COALESCE(p_audience,0) < 2 THEN 0
                     ELSE least(1, ln(p_audience::numeric) / ln(1000000)) END)
      + 0.10 * (CASE WHEN p_last_active IS NULL THEN 0
                     ELSE greatest(0, 1 - (extract(epoch FROM (now() - p_last_active)) / (365*86400))) END)
      + 0.05 * (COALESCE(p_confidence,0)::numeric / 10)
  )))::integer
$$;

-- Bulk recompute: derives per-relationship signals from history + snapshots,
-- writes relationship_score, is_supporter, and outreach_status. Phase 2 will
-- call this continuously; Phase 1 runs it once at the end of the backfill.
CREATE OR REPLACE FUNCTION public.rie_recompute_scores()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  WITH sig AS (
    SELECT r.id,
      count(DISTINCT h.song) FILTER (WHERE h.event_type = 'placement') AS placements,
      count(*)               FILTER (WHERE h.event_type = 'reply')     AS replies,
      count(*)               FILTER (WHERE h.event_type = 'pitch_sent') AS pitches
    FROM public.relationships r
    LEFT JOIN public.relationship_history h ON h.relationship_id = r.id
    GROUP BY r.id
  ),
  ret AS (
    -- follower growth across a relationship's playlists (only where snapshots exist)
    SELECT rp.relationship_id,
      least(1, greatest(0,
        (sum(latest.fc) - sum(earliest.fc))::numeric / NULLIF(sum(earliest.fc), 0)
      )) AS growth
    FROM public.relationship_playlists rp
    JOIN LATERAL (
      SELECT follower_count AS fc FROM public.follower_snapshots f
      WHERE f.playlist_id = rp.playlist_id ORDER BY snapshot_date ASC LIMIT 1
    ) earliest ON true
    JOIN LATERAL (
      SELECT follower_count AS fc FROM public.follower_snapshots f
      WHERE f.playlist_id = rp.playlist_id ORDER BY snapshot_date DESC LIMIT 1
    ) latest ON true
    GROUP BY rp.relationship_id
  )
  UPDATE public.relationships r SET
    relationship_score = public.rie_relationship_score(
      s.placements::int,
      s.replies::int,
      COALESCE(rt.growth, 0),
      CASE WHEN COALESCE(array_length(r.genres, 1), 0) >= 1 THEN 1.0 ELSE 0.5 END,
      r.audience_size,
      r.last_active,
      r.confidence_score
    ),
    is_supporter = (s.placements > 0),
    outreach_status = CASE
      WHEN s.placements > 0 THEN 'supporter'
      WHEN s.replies   > 0 THEN 'replied'
      WHEN s.pitches   > 0 THEN 'contacted'
      ELSE 'not_contacted' END,
    updated_at = now()
  FROM sig s LEFT JOIN ret rt ON rt.relationship_id = s.id
  WHERE r.id = s.id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;


-- ----------------------------------------------------------------------------
-- 5) BACKFILL — ingest the relationship data we ALREADY have. Idempotent.
--    dedupe_key expression is repeated verbatim so the joins line up; keep the
--    four INSERTs consistent if you ever change it.
-- ----------------------------------------------------------------------------

-- 5a) playlist_targets -> relationships (rolled up by dedupe_key)
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
) s
GROUP BY s.dk
ON CONFLICT (dedupe_key) DO UPDATE SET
  spotify_owner_id = COALESCE(r.spotify_owner_id, excluded.spotify_owner_id),
  name             = COALESCE(r.name, excluded.name),
  email            = COALESCE(r.email, excluded.email),
  instagram        = COALESCE(r.instagram, excluded.instagram),
  tiktok           = COALESCE(r.tiktok, excluded.tiktok),
  website          = COALESCE(r.website, excluded.website),
  genres           = excluded.genres,
  audience_size    = GREATEST(r.audience_size, excluded.audience_size),
  last_active      = GREATEST(r.last_active, excluded.last_active),
  confidence_score = GREATEST(r.confidence_score, excluded.confidence_score),
  updated_at       = now();

-- 5b) playlist_targets -> relationship_playlists (one bridge row per playlist)
INSERT INTO public.relationship_playlists (
  relationship_id, playlist_id, playlist_name, follower_count, genre,
  first_discovered, last_seen, is_active
)
SELECT r.id, pt.playlist_id, pt.playlist_name, pt.follower_count, pt.lane,
       pt.created_at, pt.updated_at, COALESCE(pt.is_active, true)
FROM public.playlist_targets pt
JOIN public.relationships r ON r.dedupe_key = COALESCE(
  NULLIF(pt.research_context->>'spotify_owner_id', ''),
  'email:' || lower(NULLIF(pt.curator_email, '')),
  'ig:'    || lower(NULLIF(pt.curator_instagram, '')),
  'name:'  || lower(NULLIF(pt.curator_name, '')),
  'playlist:' || pt.playlist_id
)
ON CONFLICT (playlist_id) DO UPDATE SET
  relationship_id = excluded.relationship_id,
  playlist_name   = excluded.playlist_name,
  follower_count  = excluded.follower_count,
  genre           = excluded.genre,
  last_seen       = excluded.last_seen,
  is_active       = excluded.is_active;

-- 5c) playlist_targets -> relationship_history 'discovered'
INSERT INTO public.relationship_history (
  relationship_id, event_type, source, source_id, occurred_at, playlist_id, playlist_name
)
SELECT rp.relationship_id, 'discovered', 'playlist_targets', pt.id::text,
       pt.created_at, pt.playlist_id, pt.playlist_name
FROM public.playlist_targets pt
JOIN public.relationship_playlists rp ON rp.playlist_id = pt.playlist_id
ON CONFLICT (source, source_id, event_type) DO NOTHING;

-- 5d) pitch_log -> relationship_history: pitch_sent
INSERT INTO public.relationship_history (
  relationship_id, event_type, source, source_id, occurred_at, playlist_id, song
)
SELECT rp.relationship_id, 'pitch_sent', 'pitch_log', pl.id::text,
       COALESCE(pl.pitched_at, pl.sent_at, pl.created_at), pl.playlist_id, pl.track_name
FROM public.pitch_log pl
JOIN public.relationship_playlists rp ON rp.playlist_id = pl.playlist_id
WHERE COALESCE(pl.pitched_at, pl.sent_at, pl.created_at) IS NOT NULL
ON CONFLICT (source, source_id, event_type) DO NOTHING;

-- 5e) pitch_log -> relationship_history: reply (no reply timestamp stored; use sent_at)
INSERT INTO public.relationship_history (
  relationship_id, event_type, source, source_id, occurred_at, playlist_id, song
)
SELECT rp.relationship_id, 'reply', 'pitch_log', pl.id::text,
       COALESCE(pl.sent_at, pl.pitched_at, pl.created_at), pl.playlist_id, pl.track_name
FROM public.pitch_log pl
JOIN public.relationship_playlists rp ON rp.playlist_id = pl.playlist_id
WHERE pl.reply_received IS TRUE
ON CONFLICT (source, source_id, event_type) DO NOTHING;

-- 5f) pitch_log -> relationship_history: placement (a song of ours was added)
INSERT INTO public.relationship_history (
  relationship_id, event_type, source, source_id, occurred_at, playlist_id, song,
  num_additions, catalog_placements
)
SELECT rp.relationship_id, 'placement', 'pitch_log', pl.id::text,
       COALESCE(pl.pitched_at, pl.sent_at, pl.created_at), pl.playlist_id, pl.track_name,
       1, 1
FROM public.pitch_log pl
JOIN public.relationship_playlists rp ON rp.playlist_id = pl.playlist_id
WHERE pl.placed IS TRUE OR pl.placement_status = 'placed'
ON CONFLICT (source, source_id, event_type) DO NOTHING;

-- 5g) roll contact/reply timestamps back onto the relationship
UPDATE public.relationships r SET
  last_contact = agg.last_contact,
  last_reply   = agg.last_reply,
  updated_at   = now()
FROM (
  SELECT rp.relationship_id,
    max(COALESCE(pl.pitched_at, pl.sent_at)) AS last_contact,
    max(pl.sent_at) FILTER (WHERE pl.reply_received IS TRUE) AS last_reply
  FROM public.pitch_log pl
  JOIN public.relationship_playlists rp ON rp.playlist_id = pl.playlist_id
  GROUP BY rp.relationship_id
) agg
WHERE r.id = agg.relationship_id;

-- 5h) compute all scores + supporter flags + outreach_status
SELECT public.rie_recompute_scores();


-- ----------------------------------------------------------------------------
-- 6) Convenience read view for the eventual admin UI (join-free rollup).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_relationship_summary AS
SELECT
  r.id, r.relationship_type, r.name, r.organization, r.platform,
  r.email, r.instagram, r.website, r.territory, r.genres,
  r.audience_size, r.relationship_score, r.is_supporter, r.outreach_status,
  r.last_active, r.last_contact, r.last_reply, r.confidence_score,
  (SELECT count(*) FROM public.relationship_playlists rp WHERE rp.relationship_id = r.id) AS playlist_count,
  (SELECT count(*) FROM public.relationship_history h
     WHERE h.relationship_id = r.id AND h.event_type = 'placement')                       AS placement_count,
  r.created_at, r.updated_at
FROM public.relationships r;


-- ----------------------------------------------------------------------------
-- 7) RLS — service-role only, exactly like playlist_targets / pitch_log.
--    All reads/writes go through edge functions (SUPABASE_SERVICE_ROLE_KEY,
--    which bypasses RLS). Deny anon and authenticated direct access.
-- ----------------------------------------------------------------------------
ALTER TABLE public.relationships           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_playlists  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_stations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_shows      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_history    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'relationships','relationship_playlists','relationship_stations',
    'relationship_shows','relationship_history'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Service role full access on '||t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Deny anonymous access to '||t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Deny authenticated direct access to '||t, t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'Service role full access on '||t, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO anon USING (false)',
      'Deny anonymous access to '||t, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (false)',
      'Deny authenticated direct access to '||t, t);
  END LOOP;
END $$;

-- ============================================================================
-- END RIE Phase 1. To verify after apply:
--   SELECT count(*) FROM public.relationships;
--   SELECT count(*) FROM public.relationship_playlists;
--   SELECT count(*) FROM public.relationship_history;
--   SELECT relationship_type, count(*), round(avg(relationship_score)) avg_score,
--          count(*) FILTER (WHERE is_supporter) supporters
--     FROM public.relationships GROUP BY 1;
--   SELECT name, relationship_score, outreach_status, audience_size
--     FROM public.relationships ORDER BY relationship_score DESC LIMIT 20;
-- ============================================================================
