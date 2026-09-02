# Phase 0 — Atomic cutover (PR #8)

**Status:** DO NOT MERGE / DO NOT REDEPLOY senders until this checklist is green.  
**PR:** keep Draft. Lyric provider remains deferred.

Redeploying `execute-pitch` alone while `send-pitch-email` stays ungated (or before Song DNA + active campaigns exist) creates a **broken cutover**. Both playlist senders share `send-identity-gate.ts` and fail closed until armed.

## Order (strict)

1. **Song DNA schema** — apply Phase 1 `song_dna_versions` (+ related) via Lovable SQL Editor.
2. **Campaign table stack** (if `to_regclass('public.pitch_campaigns')` is still null):
   - `20260718005000_admin_roles.sql` (if needed)
   - `20260718000000_pitch_campaigns.sql`
   - `20260718010000_pitch_campaigns_phase1.sql` (revised **draft** seed)
   - `20260902000000_pitch_campaigns_activation_gate.sql`
   - `20260902120000_replace_sync_eligible_and_pitch_identity.sql`
   - `20260902190000_control_pitch_log_track_id_backfill.sql` (idempotent; already applied live 2026-09-02)
   - `20260902200000_campaign_gate_require_and_control_backfill.sql` (**fails loudly** if `pitch_campaigns` missing; adds/verifies gate columns + `pitch_log.campaign_id` FK)
3. **Fendi approvals** — approve Song DNA versions in-product (no Cursor bot role).
4. **Active campaigns** — create drafts in Pitch Portal, then activate with signed-in admin JWT (approver = server-derived `user_id`).
5. **Arm gate** — Lovable Cloud → Secrets: set `PITCH_IDENTITY_GATE=required` (and confirm `FANFUEL_HUB_KEY`).
6. **Redeploy together** via Lovable Edge Functions (Cloud) — never CLI:
   - `execute-pitch`
   - `send-pitch-email`
   - `control-center-api`
7. **Verify** with SQL + a dry send that missing `track_id`/`campaign_id` and missing credentials are rejected on **both** senders.

## Env / auth contracts

| Secret / header | Behavior |
|-----------------|----------|
| `PITCH_IDENTITY_GATE=required` | Arms shared campaign identity gate on both playlist senders. Unset → HTTP 503 (no title-only bypass). |
| `FANFUEL_HUB_KEY` | Required on senders. **Missing credentials** and **wrong credentials** both reject (fail-closed). |
| Admin JWT on CCA | `create_campaign` / `update_campaign` / activation require admin role. Approver text in body is ignored. |

## Live verification already captured (Lovable `query_database`, project `4778d2a5-…`)

| Check | Result (2026-09-02) |
|-------|---------------------|
| `pitch_campaigns` | **null** (not created yet) |
| `song_dna_versions` | **null** |
| Control sent rows with null `track_id` matching `%designed for me%` **before** backfill | 139 |
| After deterministic backfill | `control_null_leftover=0`, `control_uuid_count=139` |
| `pitch_log_campaign_id_fkey` | **absent** until campaigns table + `20260902200000` |

Re-run after cutover:

```sql
select to_regclass('public.pitch_campaigns') as pitch_campaigns,
       to_regclass('public.song_dna_versions') as song_dna;
select count(*) from pitch_log
 where status='sent' and track_id is null
   and lower(track_name) like '%designed for me%';  -- expect 0
select conname from pg_constraint where conname='pitch_log_campaign_id_fkey';
select count(*) from pitch_campaigns where status='active' and authority_kind='live';
```

## Explicit non-goals this cycle

- No merge, no production Publish of gated senders until steps 1–6 complete.
- No lyric vendor selection.
- No inventing licenses, contacts, or DNA approvals.
