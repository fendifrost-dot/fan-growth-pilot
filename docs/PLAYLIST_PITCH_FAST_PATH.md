# Fast path — first curator email pitch (≈30 minutes)

For the **Designed For Me (Control) / deep_house_groove** walkthrough with named curator candidates, see **[MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md](./MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md)**.

Goal: **one real email sent** without waiting on full auto-discovery.

## Prerequisites

- Lovable **Publish** (frontend) + redeploy **`control-center-api`** and **`playlist-research`**
- Edge secrets: `FIRECRAWL_API_KEY`, `FANFUEL_HUB_KEY`, Resend configured for `send-pitch-email`
- Lanes config applied: run `supabase/migrations/20260525_artist_config_lanes.sql` in SQL Editor

## Path A — You already have a curator email (fastest)

1. Open **`/admin/playlists`**
2. Find any row (or filter lane `deep_house_groove`)
3. Click **Set email** → paste `curator@example.com`
4. Click **Draft** on that row
5. Open **`/admin/outreach`** → select draft → edit if needed → **Approve & send**

If send fails, check Cloud logs for `send-pitch-email` and Resend.

## Path B — Seed one playlist from Spotify (≈10 min)

1. In a browser, open: `https://open.spotify.com/search/kaytranada/playlists`
2. Pick a curator playlist → copy ID from URL: `open.spotify.com/playlist/XXXXXXXX`
3. Lovable **SQL Editor** — run (replace placeholders):

```sql
INSERT INTO public.playlist_targets (
  playlist_id, platform, playlist_name, curator_name, curator_email,
  follower_count, fraud_score, fraud_verdict, tier, whitelist_status,
  vibe_tags, similar_artists, pitch_status, submission_method,
  submission_url, is_active, lane, research_context
) VALUES (
  'spotify:YOUR_PLAYLIST_ID',
  'spotify',
  'Your Playlist Name',
  'Curator Name',
  'curator@email.com',  -- paste real email when you have it
  5000,
  50, 'safe', 2, false,
  '["kaytranada","deep_house"]'::jsonb,
  '["Kaytranada","Channel Tres"]'::jsonb,
  'not_pitched',
  'email',
  'https://open.spotify.com/playlist/YOUR_PLAYLIST_ID',
  true,
  'deep_house_groove',
  '{"source":"manual_seed","fetched_at":"' || now()::text || '"}'::jsonb
)
ON CONFLICT (playlist_id) DO UPDATE SET
  curator_email = EXCLUDED.curator_email,
  lane = EXCLUDED.lane,
  is_active = true,
  updated_at = now();
```

4. Refresh `/admin/playlists` → **Draft** → **`/admin/outreach`** → Approve & send

Template file: `supabase/migrations/20260529_manual_playlist_seed.sql`

## Path C — Automated discovery (when you have time)

1. **`/admin/playlists`** → **Quick research** (2 refs, ~20–40s) or **Full research** (slower)
2. **Enrich contacts** (runs in batches of 5; click again until toast says done)
3. **Set email** on any row enrich missed
4. Draft → Outreach → Send

## References for “Designed For Me (Control)”

```json
{
  "track_name": "Designed For Me (Control)",
  "lane": "deep_house_groove",
  "references": ["Kaytranada", "Channel Tres", "SG Lewis"],
  "user_vibe": "Chicago deep house groove, late-night luxury"
}
```

## curl equivalents

```bash
export CCA="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"

# Patch email
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"patch_target","playlist_id":"spotify:ID","curator_email":"you@curator.com"}'

# Draft
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"draft_pitch","playlist_id":"spotify:ID","track_name":"Designed For Me (Control)"}'

# Approve + send (use draft_id from response)
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"approve_draft","draft_id":"UUID","approved_by":"fendi","send_immediately":true}'

# QA send — real email, no pitch_log / cooldown / pitched status
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"approve_draft","draft_id":"UUID","approved_by":"fendi","send_immediately":true,"test_mode":true,"test_email":"fendifrost@gmail.com"}'

# Log manual Groover / Soundplate submission (track_name required if target row has none)
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"log_platform_pitch","playlist_id":"spotify:ID","platform_name":"groover","track_name":"Designed For Me (Control)","platform_pitch_url":"https://groover.co/...","platform_cost_usd":3}'

# Clear last_pitched_at after accidental QA (no SQL needed)
curl -sS -X POST "$CCA" -H "content-type: application/json" \
  -d '{"action":"patch_target","playlist_id":"spotify:ID","last_pitched_at":null}'
```

**Spotify vendor emails:** if enrich stored `ap@spotify.com`, run `supabase/migrations/20260601_scrub_spotify_vendor_emails.sql` in SQL Editor.
