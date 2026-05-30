# Apple Radio Growth — remaining build handoff (for Cursor)

Companion to `APPLE_RADIO_HANDOFF.md`. Reflects **verified live state as of 2026-05-30**, after migration + publish + first data load.

**Code landed 2026-05-28 (deploy required):** see bottom § “Implemented in repo”.

---

## Verified live state (confirmed against prod, not assumed)

| Piece | State |
|-------|-------|
| Schema (`apple_station_plays`, `apple_city_spins`, `radio_targets`, `radio_pitch_log`) | **Applied** via Lovable SQL editor. Confirmed via REST. |
| `control-center-api` actions `ingest_apple_spins`, `get_radio_targets` | **Deployed.** `get_radio_targets` → 37 rows. |
| Outreach actions `draft_radio_pitch`, `send_radio_pitch`, `patch_radio_target`, `get_radio_pitch_log`, `backfill_apple_station_baseline` | **Deployed** (respond with validation guards). |
| `radio_targets` | **Populated: 37 stations, 595 lifetime spins.** All warmth=`already_playing`. |
| `apple_station_plays` | **EMPTY** until backfill or real `amfa_radio_capture.js` ingest. |
| `apple_city_spins`, `radio_pitch_log` | Empty until city capture + pitches. |
| `radio_targets.contact_email` | **All NULL** until enrichment run. |

AMFA artist id: `ami:identity:72d54136996b56baf4ce3a639d6a09ee`. Capture: `amfa_radio_capture.js`.

---

## 1. `apple_station_plays` baseline

**Fixed in repo:** `backfill_apple_station_baseline` now accepts `[{song_name, spins}]` (synthetic `song_id` = `backfill-name:<hash>`, flagged `lossy` in metadata).

**Preferred:** Run `amfa_radio_capture.js` while logged into AMFA — real `song_id`, geo, `period_start/end`.

**After deploy:** Admin → Radio → **Backfill play-log baseline** or re-run capture script.

## 2. Contact enrichment — REQUIRED before send

**Fixed in repo:** `enrich_radio_contacts` — Firecrawl search + scrape, ranked by `total_spins`, writes `patch_radio_target` fields.

**After deploy:** Admin → Radio → **Enrich contacts (top 10)** (repeat until `withEmail` ≈ warm stations). Needs `FIRECRAWL_API_KEY`.

## 3. `apple_city_spins`

**Fixed in repo:** `ingest_apple_spins` accepts optional `cities[]`; `amfa_radio_capture.js` fetches KPI `breakout=city` (not `top_cities` flags-only).

**After deploy:** Re-run capture script while logged into AMFA.

## 4. Weekly scheduling — auth constraint (unchanged)

Capture needs Fendi's **authenticated AMFA browser session**. No unattended server cron unless AMFA token refresh exists. Prompt weekly: run `amfa_radio_capture.js` in console.

## 5. Smart-link Apple intent (#5) — still open

Coordinate with truth-layer / canonical `events` table. Do not add parallel schema.

## 6. Shazam city scrape — deprioritized

Superseded by `apple_city_spins` (#3).

## 7. Telegram radio summary — future

After 1–3 + outreach sends work.

---

## Suggested order (ops)

1. **Deploy** `control-center-api` (+ `_shared/radio-outreach.ts`, `radio-enrich.ts`).
2. **Enrich** top stations via admin (or `enrich_radio_contacts` with `limit: 10`, loop `offset`).
3. **Backfill** or **AMFA capture** for `apple_station_plays` + cities.
4. **Draft / send** radio pitches on rows with email.

---

## Implemented in repo (2026-05-28)

| Item | Files |
|------|--------|
| Backfill song_name shape | `supabase/functions/_shared/radio-outreach.ts` |
| `enrich_radio_contacts` | `radio-enrich.ts`, `radio-outreach.ts`, `AdminRadioTargets.tsx` |
| City ingest | `control-center-api/index.ts` (`cities[]`), `amfa_radio_capture.js` |

### Smoke (after deploy)

```bash
# Backfill (lossy IDs ok)
curl -sS -X POST "$CCA_URL" -H "x-api-key: $HUB_KEY" -H "content-type: application/json" \
  -d '{"action":"backfill_apple_station_baseline","snapshot_week":"2026-05-26"}'

# Enrich warmest 3
curl -sS -X POST "$CCA_URL" -H "x-api-key: $HUB_KEY" -H "content-type: application/json" \
  -d '{"action":"enrich_radio_contacts","limit":3,"offset":0}'
```
