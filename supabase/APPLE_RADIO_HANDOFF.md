# Apple Music Radio Growth — deploy handoff

Two coupled changes must land **together** (the new action references the new tables).

## 1. Apply schema (Lovable migration tool — canonical)
Paste `supabase/migrations/20260530_apple_radio_growth.sql` into the Lovable migration tool and run.
Idempotent (`CREATE TABLE IF NOT EXISTS`), additive only, does **not** touch the events/truth-layer table.
Creates: `apple_station_plays`, `apple_city_spins`, `radio_targets`, `radio_pitch_log`.

## 2. Deploy edge function (GitHub → Lovable Publish)
`supabase/functions/control-center-api/index.ts` has two new actions:
- `ingest_apple_spins` (write — requires `x-api-key: FANFUEL_HUB_KEY`)
- `get_radio_targets` (read)

Commit to `main`, then Lovable → **Publish** (redeploys the existing function — no new function created, so no CLI/403 issue).

## 3. Run first capture (populates real data)
1. Log into https://artists.apple.com (any Measure page).
2. Open `amfa_radio_capture.js` (in the Fan Fuel Hub folder), set `HUB_KEY = FANFUEL_HUB_KEY`.
3. Paste into the AMFA browser console (or let Claude run it via the Chrome extension on that tab).
4. It pulls all 211 songs → spins-by-station → POSTs to `ingest_apple_spins`.
   Expected first run: ~37 stations, 595 lifetime spins (matches the 2026-05-30 seed snapshot).

## 4. Verify
- `SELECT count(*), sum(spins_total) FROM apple_station_plays WHERE snapshot_week = date_trunc('week', now())::date;`
- `SELECT station_call_sign, city, total_spins, warmth FROM radio_targets ORDER BY total_spins DESC LIMIT 10;`
- Re-run weekly: diffing `snapshot_week` rows gives real week-over-week spin deltas (no fabricated numbers).

## Notes
- `radio_targets` upsert preserves manual fields (`contact_email`, `pitch_status`, `notes`, `pitched_at`) — only metrics/geo/warmth refresh each capture.
- Next build (after this lands): seed `contact_email`/`submission_url` enrichment + DJ/station pitch send via existing `send-pitch-email`, logged to `radio_pitch_log`.
