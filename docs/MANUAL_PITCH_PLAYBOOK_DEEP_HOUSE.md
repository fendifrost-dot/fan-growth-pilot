# Manual pitch playbook — first deep-house curator end-to-end

**Project:** Fan Fuel Hub playlist agent  
**Supabase project_id:** `vsemrziqxrrfcquxfnwd`  
**CCA endpoint:** `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api`  
**Date:** 2026-05-29  

Prove **draft → approve → send** on a real deep-house curator. Public web search often does not surface curator emails; finding the first one is a manual ~10-minute job. Enrich v2 automates Linktree + IG deep scans after this pattern is validated once.

**UI shortcut:** `/admin/playlists` → **Set email** → **Draft** → `/admin/outreach` → Approve & send (same loop, no curl).

---

## 0) Candidate curators (Kaytranada lane)

| Curator | Spotify playlist | Notes |
|---|---|---|
| Khwezi Zwane | [Kaytranada Funk House Party](https://open.spotify.com/playlist/61MN7Wzq4sg2rJUl9ypAZg) | ~91 tracks. Active. |
| Mixchelle the Curator | [Kaytranada Vibes](https://open.spotify.com/playlist/20beleNSUDwXR1QHaSxsAB) | "the Curator" — may pitch publicly. |
| Off Label | [If You Like: KAYTRANADA](https://open.spotify.com/playlist/0m2BLwkbHD1vD8HF1uO9u6) | Brand handle — check Linktree / submission first. |
| indigo | [KAYTRANADA Production Discography](https://open.spotify.com/playlist/2cfbhGzHheIDIb7fEUDUNf) | Aggregator — lower priority. |
| Liam Murphy | [Best of KAYTRANADA](https://open.spotify.com/playlist/1flrKkH2TsjXDflrChHGoz) | Personal — lower priority. |

**Priority:** Off Label → Mixchelle → Khwezi.

---

## 1) Find the email (manual)

1. Open the Spotify playlist URL.
2. Click the **curator name** → Spotify user profile.
3. Read bio for email, Linktree, IG, or website.
4. Open **Linktree / Beacons / lnk.bio** if linked — email is often on a button.
5. Open **Instagram** if linked — look for mailto, 📩 lines, or "submissions@" text.

Stop at the first real email. No fabrication.

---

## 2) Find or create the `playlist_targets` row

### Option A — row already in catalog

```bash
export SUPABASE="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"

curl -sS -X POST "$SUPABASE" -H "content-type: application/json" \
  -d '{"action":"list_targets","lane":"deep_house_groove"}' | \
  python3 -c "
import sys, json
rows = json.load(sys.stdin).get('rows', [])
hits = [r for r in rows if 'kaytranada' in (r.get('playlist_name','') + (r.get('curator_name') or '')).lower()]
for r in hits:
    print(r.get('playlist_id'), '|', r.get('curator_name'), '|', r.get('playlist_name'), '|', r.get('submission_method'))
"
```

### Option B — insert manually (SQL Editor)

```sql
INSERT INTO public.playlist_targets (
  playlist_id, platform, playlist_name, curator_name, curator_email,
  follower_count, fraud_score, fraud_verdict, tier, pitch_status,
  submission_method, contact_confidence, is_active, lane,
  submission_url, research_context, vibe_tags, similar_artists
) VALUES (
  'spotify:0m2BLwkbHD1vD8HF1uO9u6',
  'spotify',
  'If You Like: KAYTRANADA',
  'Off Label',
  'REPLACE_WITH_EMAIL@curator.com',
  0, 50, 'safe', 2, 'not_pitched',
  'email', 9, true, 'deep_house_groove',
  'https://open.spotify.com/playlist/0m2BLwkbHD1vD8HF1uO9u6',
  '{"source":"manual_seed","manually_seeded":true}'::jsonb,
  '["kaytranada","deep_house"]'::jsonb,
  '["Kaytranada","Channel Tres"]'::jsonb
)
ON CONFLICT (playlist_id) DO UPDATE SET
  curator_email = EXCLUDED.curator_email,
  submission_method = 'email',
  contact_confidence = 9,
  lane = EXCLUDED.lane,
  is_active = true,
  updated_at = now();
```

### Option C — patch via API (no SQL)

```bash
curl -sS -X POST "$SUPABASE" -H "content-type: application/json" \
  -d '{"action":"patch_target","playlist_id":"spotify:0m2BLwkbHD1vD8HF1uO9u6","curator_email":"REPLACE@curator.com"}'
```

---

## 3) Update email on existing row (SQL)

```sql
UPDATE public.playlist_targets
   SET curator_email      = 'REPLACE_WITH_EMAIL@curator.com',
       submission_method  = 'email',
       contact_confidence = 9,
       last_enriched_at   = now()
 WHERE playlist_id = 'spotify:0m2BLwkbHD1vD8HF1uO9u6';
```

---

## 4) Draft the pitch

```bash
curl -sS -X POST "$SUPABASE" -H "content-type: application/json" -d '{
  "action": "draft_pitch",
  "playlist_id": "spotify:0m2BLwkbHD1vD8HF1uO9u6",
  "track_name": "Designed For Me (Control)"
}'
```

Expected: `{ "ok": true, "draft_id": "...", "channel": "email", "recipient": "...", "subject": "...", "body": "..." }`.

Review at: `https://fan-growth-pilot.lovable.app/admin/outreach`

---

## 5) Review checklist

- Opens with curator or playlist name (not generic).
- Uses **deep_house_groove** pitch angle from `artist_config.lanes`, not rap lane copy.
- Track / smart link present if configured in draft template.
- Tone matches Fendi — edit in UI before send if needed.

---

## 6) Approve and send

**UI:** `/admin/outreach` → Approve & send.

**CLI:**

```bash
curl -sS -X POST "$SUPABASE" -H "content-type: application/json" -d '{
  "action": "approve_draft",
  "draft_id": "<draft_id from step 4>",
  "approved_by": "fendi",
  "send_immediately": true
}'
```

Expected: `{ "ok": true, "sent": true, ... }` (exact fields depend on Resend response).

---

## 7) Verify

```bash
curl -sS -X POST "$SUPABASE" -H "content-type: application/json" \
  -d '{"action":"get_pitch_log","limit":5}' | python3 -m json.tool
```

Also check [Resend dashboard](https://resend.com/emails) for the outbound message.

---

## 8) No email after ~15 minutes

Try the next curator in §0, or route to IG-DM:

```sql
UPDATE public.playlist_targets
   SET curator_instagram   = 'handle_without_at',
       submission_method   = 'instagram_dm',
       contact_confidence  = 4,
       last_enriched_at    = now()
 WHERE playlist_id = 'spotify:<id>';

INSERT INTO public.social_engagement_queue (
  platform, action, target_url, draft_text, playlist_id, status, result
) VALUES (
  'instagram',
  'pitch_dm',
  'https://www.instagram.com/handle_without_at/',
  'Hey — saw your Kaytranada-adjacent playlist. New single **Designed For Me (Control)** fits that lane (deep house + Channel Tres / Kaytranada DNA). Happy to share a stream link for a one-add test.',
  'spotify:<id>',
  'pending',
  '{"lane":"deep_house_groove","source":"manual_pitch_playbook"}'::jsonb
);
```

Or use **Queue DM** on `/admin/playlists` after Enrich v2 tags the row `instagram_dm`.

---

## 9) Constraints

- No fake emails.
- No bulk stale lists from third-party scrapers — use Firecrawl discovery + this manual pass.
- Do not clear `pitch_log` cooldowns unless the curator invites a re-pitch.
- `contact_confidence`: manual email = **9**, IG-only = **4**, Hunter/automated = **3–7** per enrich path.

---

## Related docs

- [PLAYLIST_PITCH_FAST_PATH.md](./PLAYLIST_PITCH_FAST_PATH.md) — generic fast path  
- [PLAYLIST_DISCOVERY_STATUS.md](./PLAYLIST_DISCOVERY_STATUS.md) — what's automated vs manual  
- `supabase/migrations/20260530_enrich_v2_columns.sql` — run before bulk enrich  
