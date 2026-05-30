-- Apple Music for Artists — Radio/DJ growth tables
-- Source of truth: AMFA JSON API (artists.apple.com/api/measure/*)
-- Apply via Lovable migration tool. Additive only — does NOT touch the events/truth-layer table.
--
-- Field mapping (verified from live API responses 2026-05-30):
--   /api/measure/stats/kpi?...breakout=station  -> apple_station_plays
--     result.kpiTotal                 -> spins_total
--     result.query.song               -> song_id
--     result.meta.station.{id,callSign,band,frequency,timezone}
--     result.meta.geo.{name,areaName,countryCode,latitude,longitude,id}
--     kpi.startDate / kpi.endDate     -> period_start / period_end
--   /api/measure/catalog/{aid}/songs  -> song_id + song_name (contentGroupId/Name)
--   /api/measure/locations/{aid}/top_cities?filters=SPINS -> apple_city_spins

-- 1) apple_station_plays: weekly cumulative snapshot of radio spins by station, per song.
--    One row per (song, station, week). Week-over-week deltas come from diffing snapshots
--    (no fabricated "this week" numbers — every value is a real captured cumulative total).
CREATE TABLE IF NOT EXISTS public.apple_station_plays (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id         text NOT NULL,                 -- ami:identity:...
  song_id           text NOT NULL,                 -- AMFA contentGroupId
  song_name         text,
  station_id        text NOT NULL,                 -- AMFA station id
  station_call_sign text,
  band              text,
  frequency         text,
  timezone          text,
  city              text,
  area_name         text,                          -- state / region
  country_code      text,
  latitude          double precision,
  longitude         double precision,
  geo_id            text,
  spins_total       integer NOT NULL DEFAULT 0,    -- kpiTotal (cumulative for the period)
  period_start      date,
  period_end        date,
  snapshot_week     date NOT NULL,                 -- Monday of capture week (dedupe + trend key)
  captured_at       timestamptz NOT NULL DEFAULT now(),
  metadata          jsonb DEFAULT '{}'::jsonb,
  UNIQUE (song_id, station_id, snapshot_week)
);
CREATE INDEX IF NOT EXISTS idx_apple_station_plays_station ON public.apple_station_plays (station_id);
CREATE INDEX IF NOT EXISTS idx_apple_station_plays_song    ON public.apple_station_plays (song_id);
CREATE INDEX IF NOT EXISTS idx_apple_station_plays_week    ON public.apple_station_plays (snapshot_week DESC);
CREATE INDEX IF NOT EXISTS idx_apple_station_plays_city    ON public.apple_station_plays (city);

-- 2) apple_city_spins: weekly artist-level city spin snapshot (AMFA top_cities filters=SPINS).
CREATE TABLE IF NOT EXISTS public.apple_city_spins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id      text NOT NULL,
  geo_id         text,
  city           text,
  area_name      text,
  country_code   text,
  latitude       double precision,
  longitude      double precision,
  spins_total    integer DEFAULT 0,
  has_spins_data boolean,
  snapshot_week  date NOT NULL,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  metadata       jsonb DEFAULT '{}'::jsonb,
  UNIQUE (geo_id, snapshot_week)
);
CREATE INDEX IF NOT EXISTS idx_apple_city_spins_week ON public.apple_city_spins (snapshot_week DESC);

-- 3) radio_targets: outreach CRM for stations / DJs. Mirrors playlist_targets.
--    Seeded from apple_station_plays — a station that already spun a song is the warmest lead.
CREATE TABLE IF NOT EXISTS public.radio_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id        text UNIQUE NOT NULL,          -- AMFA station id (or manual:<slug>)
  station_call_sign text NOT NULL,
  station_type      text NOT NULL DEFAULT 'radio', -- radio | dj | club
  city              text,
  area_name         text,
  country_code      text,
  timezone          text,
  contact_name      text,
  contact_email     text,
  contact_url       text,                          -- website / IG / submission form
  submission_method text,                          -- email | form | dm | unknown
  total_spins       integer DEFAULT 0,             -- denormalized rollup from station_plays
  songs_played      jsonb DEFAULT '[]'::jsonb,     -- [{song_id, song_name, spins}]
  warmth            text NOT NULL DEFAULT 'cold',  -- already_playing | warm | cold
  pitch_status      text NOT NULL DEFAULT 'not_pitched',
  pitched_at        timestamptz,
  last_contact_at   timestamptz,
  notes             text,
  metadata          jsonb DEFAULT '{}'::jsonb,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radio_targets_status ON public.radio_targets (pitch_status);
CREATE INDEX IF NOT EXISTS idx_radio_targets_warmth ON public.radio_targets (warmth);
CREATE INDEX IF NOT EXISTS idx_radio_targets_city   ON public.radio_targets (city);

-- 4) radio_pitch_log: every pitch sent to a station/DJ. Mirrors pitch_log.
CREATE TABLE IF NOT EXISTS public.radio_pitch_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id        text REFERENCES public.radio_targets(station_id) ON DELETE SET NULL,
  station_call_sign text,
  song_id           text,
  song_name         text,
  channel           text NOT NULL DEFAULT 'email', -- email | form | dm
  recipient         text,
  subject           text,
  body              text,
  status            text NOT NULL DEFAULT 'draft',  -- draft | approved | sent
  resend_message_id text,
  reply_received    boolean DEFAULT false,
  sent_at           timestamptz,
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radio_pitch_log_station ON public.radio_pitch_log (station_id);

-- RLS: internal-only tool. Deny anon outright; service role (edge functions) bypasses RLS.
ALTER TABLE public.apple_station_plays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apple_city_spins    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radio_targets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radio_pitch_log     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny anon on apple_station_plays" ON public.apple_station_plays FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon on apple_city_spins"    ON public.apple_city_spins    FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon on radio_targets"       ON public.radio_targets       FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon on radio_pitch_log"     ON public.radio_pitch_log     FOR ALL TO anon USING (false);
