
-- playlist_targets: discovered playlists to pitch
CREATE TABLE IF NOT EXISTS public.playlist_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id text UNIQUE NOT NULL,
  platform text NOT NULL,
  playlist_name text NOT NULL,
  curator_name text,
  curator_email text,
  track_name text NOT NULL,
  follower_count integer DEFAULT 0,
  track_count integer DEFAULT 0,
  overlap_score integer DEFAULT 0,
  fraud_score integer DEFAULT 0,
  fraud_verdict text DEFAULT 'safe',
  pitch_status text DEFAULT 'not_pitched',
  pitched_at timestamptz,
  notes text,
  research_context jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- pitch_log: every email sent
CREATE TABLE IF NOT EXISTS public.pitch_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id text REFERENCES public.playlist_targets(playlist_id),
  track_name text NOT NULL,
  curator_email text NOT NULL,
  subject text,
  email_body text,
  sent_at timestamptz DEFAULT now(),
  reply_received boolean DEFAULT false,
  placed boolean DEFAULT false,
  resend_message_id text,
  created_at timestamptz DEFAULT now()
);

-- indexes
CREATE INDEX IF NOT EXISTS idx_playlist_targets_track ON public.playlist_targets(track_name);
CREATE INDEX IF NOT EXISTS idx_playlist_targets_status ON public.playlist_targets(pitch_status);
CREATE INDEX IF NOT EXISTS idx_pitch_log_track ON public.pitch_log(track_name);

-- RLS
ALTER TABLE public.playlist_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pitch_log ENABLE ROW LEVEL SECURITY;

-- Service role (used by control-center-api) has full access by default.
-- No user-facing RLS needed since these tables are only accessed via the edge function with service role key.
