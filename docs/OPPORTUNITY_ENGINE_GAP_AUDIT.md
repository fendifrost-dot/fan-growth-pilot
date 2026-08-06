# Opportunity Engine — Gap Audit

**Repo:** `fan-growth-pilot` (Artist Growth Hub / FanFuel Hub)
**Branch audited:** `main` @ `230a189` (latest commit adds rap-discovery query widening; the June 29 commit referenced in the handoff added Odesli smart links)
**Date:** 2026-08-01
**Author:** Opportunity Engine Phase-1 implementation session
**Method:** Read-only inspection of version-controlled code, migrations, and the generated Supabase types (`src/integrations/supabase/types.ts`, which reflects the live schema). No live DB queries were run from this session; where "live application" of a migration cannot be confirmed from the repo, it is called out explicitly.

> **Purpose of this document.** A prior independent audit found the Opportunity Engine architecture is **not** substantially implemented on `main`. This file classifies **every** requirement honestly so that Phase 1 builds on what actually exists and does not re-declare "built" for things that are not. It is deliberately conservative: a similarly-named table or page is **not** counted as the requirement.

---

## Classification legend

| Status | Meaning |
|---|---|
| **EXISTS_AND_WORKING** | Implemented, wired end-to-end, verifiable on `main` today. |
| **PARTIAL** | Real, reusable infra exists for an *adjacent* concept, but the requirement as specified (unified opportunity semantics, scoring components, stored output + workflow) is not met. |
| **PLACEHOLDER** | Something with the right name/shape exists but is not functional as specified (e.g., a score with no components, a page of static cards). |
| **MISSING** | No implementation. |
| **BLOCKED_BY_EXTERNAL_ACCESS** | Cannot be completed from the repo alone; needs a Lovable publish / SQL-editor run / third-party credential the code session does not hold. |

---

## Environment reality (affects every requirement)

- **Framework:** Vite + React 18 + React Router 6 + TypeScript, **not** Next.js. The handoff's `app/opportunities/page.tsx` path does not map to this repo. The operator surface is a single-operator admin app mounted under `/admin` (`src/App.tsx:65-83`, `src/pages/admin/*`). **Phase-1 deviation:** the Opportunity Inbox will live at `src/pages/admin/AdminOpportunities.tsx`, routed at `/admin/opportunities` and added to the `AdminGuard` nav — the repo-idiomatic equivalent of "homepage inbox + nav entry."
- **Backend:** Supabase (project `vsemrziqxrrfcquxfnwd`). Edge functions in `supabase/functions/*` (Deno). No Next.js API routes exist.
- **Auth model (important):** The single-operator app authenticates the *browser session* with Supabase Auth (`RequireAuth`, `src/components/RequireAuth.tsx`), but the main backend `control-center-api` is called **with no Authorization header** — `src/lib/hubApi.ts:8-11` states the trust model is "URL secrecy." A strong JWT+role gate exists in `supabase/functions/_shared/outreach-auth.ts` (`authorizeAction`, `resolveUser`, `has_role`), **but `grep -rn authorizeAction supabase/functions` shows it is never called** — it is written and unit-tested (`_shared/outreach-auth.test.ts`) yet unwired. A real `user_roles` table + `has_role()` function do exist (`supabase/migrations/20260718005000_admin_roles.sql`). **Phase-1 decision:** the new Opportunity API will *actually wire* JWT+role authorization (reusing the `outreach-auth` primitives) rather than inherit URL-secrecy — this is a strict improvement and satisfies the DoD "authorization implemented."
- **Migrations vs. live schema:** The canonical tables (`tracks`, `smart_links`, `fan_profiles`, `fan_events`, `relationships`, `playlist_targets`, …) were created **directly in Lovable** and are **not** all present as repo migration files (earliest repo migration is `20260523…`; `tracks`/`smart_links` DDL is absent — they show up only in the generated `types.ts`). The helper `public.touch_updated_at()` is *referenced* by `20260718010000_pitch_campaigns_phase1.sql:110` but **defined in no repo migration** (`grep` returns nothing). Phase-1 migrations must therefore be self-contained and idempotent (`create or replace` their own trigger helper) and must be committed as version-controlled files (DoD requirement).
- **Test/build scripts:** `package.json` has `dev/build/build:dev/lint/preview/verify:funnel` only. There is **no `typecheck`, `lint:ci`, or `test` script**, even though `vitest` is installed and `src/test/*` tests exist. Phase 1 adds these scripts.
- **AppleDouble pollution:** The working tree and (before this session) `.git/` were full of macOS `._*` sidecar files — 2084 inside `.git/objects/pack` were producing "non-monotonic index" git errors. Those inside `.git/` were removed this session so commit/push/PR are reliable. Working-tree `._*` files remain and must never be staged.

---

## Requirement-by-requirement audit

### 1. Unified Opportunity data model
**Status: MISSING**
- No `growth_entities`, `growth_opportunities`, `growth_relationship_events`, `opportunity_actions`, or `opportunity_outcomes` tables (`grep -ri growth_entit\|growth_opportun src supabase` → 0 files).
- What exists instead are **per-channel silos**, none of which share an opportunity abstraction: `playlist_targets` (playlist curators), `radio_targets` (stations), `relationships` (RIE contacts), `email_contacts`, `telegram_subscribers`, `fan_profiles`. Each has its own status vocabulary and its own table.
- **Verify:** `grep -ri growth_ src supabase` (none); `python3` extraction of table Row shapes from `src/integrations/supabase/types.ts` shows the silos above.
- **Limitation / reuse:** The Phase-1 `growth_entities`/`growth_opportunities` model must *reference* these silos (e.g., an opportunity's `entity` can point at a `playlist_targets` row) rather than replace them.

### 2. Opportunity Inbox homepage
**Status: MISSING**
- No inbox page. `grep -ril inbox src` matches only `PrivacyPolicy.tsx`/`DataDeletion.tsx` (email inbox prose). The admin home is `src/pages/admin/AdminHub.tsx` (a launcher of existing tools), and the app root is the fan-facing `Index.tsx`.
- **Verify:** `ls src/pages src/pages/admin` — no opportunities page.

### 3. Playlist Agent (as a unified Opportunity pipeline)
**Status: PARTIAL**
- A **genuinely working playlist discovery + pitching pipeline** exists and is the single best reuse target:
  - Edge functions: `playlist-research`, `playlist-batch`, `execute-pitch`, `pitch-status`, `playlist-admin-api`, plus shared logic `_shared/playlist-agent-run.ts`, `_shared/playlist-sweep.ts`, `_shared/playlist-lanes.ts`, `_shared/verify-target.ts`, `_shared/curator-filters.ts`.
  - Tables: `playlist_targets`, `playlist_categories`, `pitch_log`, `outreach_drafts`, `pitch_campaigns` (+`campaign_target_attempts`, `campaign_audit_events`).
  - UI: `AdminPlaylistTargets.tsx`, `AdminPlaylistReview.tsx`, `AdminPitchPortal.tsx`, `AdminPitchLog.tsx`.
- **Why not COMPLETE:** it is playlist-specific and models "targets," not "opportunities." There is no shared `opportunity_type`, no cross-channel scoring, no unified inbox. Per the independent audit, the channel itself is saturated (191 pitches → 0 placements). Phase 1 introduces the opportunity abstraction *over* this pipeline; it does not rebuild it.
- **Verify:** `ls supabase/functions | grep -E 'playlist|pitch'`; `sed -n '1,60p' supabase/functions/_shared/playlist-agent-run.ts`.

### 4. Creator Agent
**Status: MISSING** (adjacent infra PARTIAL)
- No creator-opportunity agent. Adjacent: an Instagram fan/creator DM pipeline exists (`_shared/ig-outreach.ts`, `_shared/fan-engagement-run.ts`, `_shared/ig-roster.ts`, `social_engagement_queue`, `AdminIgRoster.tsx`, `AdminSocialQueue.tsx`) but it is roster/queue-based, not opportunity-scored, and per the independent audit the IG roster is empty (0 rows) and idle.
- **Verify:** `grep -ri creator_agent src supabase` → 0.

### 5. Conversation Agent
**Status: MISSING**
- No conversation-mining agent. Inbound handling that exists is transactional webhooks only: `instagram-messaging` (auto-reply, `_shared/ig-autoreply-run.ts`, migration `20260704_ig_autoreply.sql`), `telegram-webhook`, `resend-webhook`. None extract or score conversational opportunities.
- **Verify:** `grep -ri conversation_agent src supabase` → 0.

### 6. Radio Agent
**Status: PARTIAL**
- A radio pitching pipeline exists: `radio_targets`, `radio_pitch_log`, `_shared/radio-outreach.ts`, `_shared/radio-enrich.ts`, `AdminRadioTargets.tsx`, plus Apple-radio spin ingestion (`apple_station_plays`, `apple_city_spins`, migration `20260530_apple_radio_growth.sql`).
- **Why not COMPLETE:** same as Playlist Agent — it is a channel silo (`radio_targets`), not opportunity-modeled, unscored on the 8-component scale, and not in a unified inbox.
- **Verify:** `ls supabase/functions/_shared | grep radio`; `grep -n 'radio_targets' src/integrations/supabase/types.ts`.

### 7. DJ Agent
**Status: MISSING** — `grep -ri dj_agent src supabase` → 0. (DJs are conceptually a `growth_entities.entity_type` in Phase 1, but there is no discovery/scoring for them today.)

### 8. Press Agent
**Status: MISSING** — no publication/journalist/blog discovery or pitching. No `publication`/`journalist` tables or functions.

### 9. Event Agent
**Status: MISSING** — no venue/event discovery. No `event`/`venue` tables or functions.

### 10. AI Opportunity Scoring
**Status: PLACEHOLDER** (deterministic relationship score exists; opportunity score does not)
- The RIE ships a **documented deterministic** relationship score, not ML: `public.rie_relationship_score(...)` and `public.rie_recompute_scores()` (`src/integrations/supabase/types.ts:2688-2689`; formula in `supabase/migrations/20260705_relationship_intelligence_engine.sql`, weights: placement 0.35 / reply 0.15 / retention 0.15 / genre 0.10 / audience 0.10 / …). `playlist_targets` also carries ad-hoc scalar scores (`authenticity_score`, `fraud_score`, `legitimacy_score`, `overlap_score`, `contact_confidence`).
- **Why only PLACEHOLDER for *opportunity* scoring:** none of these is an opportunity score. There is **no** `opportunity_score` and **none** of the eight required components (`audience_match_score`, `relationship_score`, `reach_score`, `response_probability`, `conversion_probability`, `effort_score`, `risk_score`, `lifetime_value_score`) stored separately. The RIE score is per-relationship, not per-opportunity, and covers only 2 of 8 axes conceptually.
- **Honesty note:** No ML model exists and none should be claimed. Phase-1 scoring is **deterministic with configurable, documented weights**, storing all 8 components separately — the RIE's `relationship_score` feeds the `relationship_score` component.
- **Verify:** `grep -n 'rie_relationship_score\|rie_recompute_scores' src/integrations/supabase/types.ts`.

### 11. Song Intelligence objects
**Status: MISSING**
- The canonical song table `public.tracks` exists (id, name, isrc, spotify/soundcloud/apple URLs, release_date, status, `pitch_angle`, `reference_artists text[]`, `short_pitch`, `default_tone`, notes) — this is the table to **extend**, not duplicate.
- But there is **no** `song_intelligence_profiles` (BPM, key, mood, energy, sonic descriptors, embeddings, similar-artist analysis, etc.). `pitch_angle`/`reference_artists` are free-text pitch metadata, not a structured intelligence profile.
- **Verify:** extract `tracks` Row shape from `types.ts`; `grep -ri song_intelligence src supabase` → 0.

### 12. Song timestamp matching
**Status: MISSING**
- No `song_clips`, no `recommended_start_seconds`/`recommended_end_seconds`, no clip/hook concept anywhere (`grep -ri song_clip\|timestamp_match src supabase` → 0). `hls.js` is a dependency but is used for audio playback on smart-link pages, not clip matching.

### 13. Relationship Memory
**Status: PARTIAL**
- The **Relationship Intelligence Engine** is the strongest existing analogue: tables `relationships`, `relationship_history`, `relationship_playlists`, `relationship_stations`, `relationship_shows`, view `v_relationship_summary`, scoring functions above, migration `20260705_relationship_intelligence_engine.sql` (+ `20260706_rie_ingest_scraped_placements.sql`). `relationship_history` is an idempotent event log (`UNIQUE(source, source_id, event_type)`) with placement/reply/follower signals.
- **Why not COMPLETE:** (a) the independent audit could not confirm the RIE migration was ever **applied to the live DB** (it is a manual SQL-editor step, not exposed via API); (b) Phase-2 continuous ingestion + admin UI + scheduled follower snapshots are **not built**; retention/radio signals are empty by design; (c) it is relationship-centric, not opportunity-centric — there is no `growth_relationship_events` feeding opportunity recalculation.
- **Reuse:** Phase-1 `growth_relationship_events` aggregation and the `relationship_score` component read from / complement the RIE rather than replace it.
- **Verify:** `sed -n '1,120p' supabase/migrations/20260705_relationship_intelligence_engine.sql`.

### 14. Distribution Graph
**Status: MISSING** — no graph of who-reaches-whom / overlap network. `playlist_targets.overlap_score` and `similar_artists` jsonb are per-row hints, not a graph. `grep -ri distribution_graph src supabase` → 0.

### 15. Fan Discovery (lookalike) Engine
**Status: PARTIAL (BLOCKED_BY_EXTERNAL_ACCESS for the actual lookalike)**
- Fan-capture + retargeting infra is real and ~90% built (per independent audit): `fan_profiles`, `fan_events`, `smart_link_leads`, `link_analytics`, Meta pixel + CAPI (`meta-conversions` edge function), truth funnel (`truth-ingest`, `truth-verify`). These make lookalike **seeds** buildable.
- **Why not COMPLETE:** the actual lookalike-audience generation happens **manually in Meta Ads Manager**, not in-app. There is no in-app "fan discovery engine" table/function that produces scored lookalike opportunities. Building the real lookalike is BLOCKED_BY_EXTERNAL_ACCESS (Meta Ads Manager). Phase 1 does not attempt it.
- **Verify:** `ls supabase/functions | grep -E 'meta|truth'`; `grep -n 'fan_profiles:\|fan_events:' src/integrations/supabase/types.ts`.

### 16. Creative Matching Engine
**Status: MISSING** — no engine matching a song/clip to an entity's audience/taste. `catalog-match.ts`/`placement-match.ts` in `_shared` match *scraped placements to catalog tracks* (attribution), not creative-to-audience fit. `grep -ri creative_match src supabase` → 0. Phase 1 ships a **deterministic** `creative-match` service stub in the service layer (documented, not ML).

### 17. Referral Intelligence
**Status: MISSING** — no referral/ambassador tracking. `grep -ri referral src supabase` → 0.

### 18. Learning Engine
**Status: MISSING**
- Event **collection** exists (`fan_events`, `link_analytics`, `pitch_log`, `relationship_history`) and the RIE has a one-shot `rie_recompute_scores()`. But there is no learning loop: outcomes are not fed back to adjust scoring weights or response/conversion probabilities. Event collection is **not** a learning system.
- **Verify:** `grep -ri learning_engine src supabase` → 0.

---

## Summary table

| # | Requirement | Status | Primary existing asset (reuse) |
|---|---|---|---|
| 1 | Unified Opportunity data model | **MISSING** | per-channel silos (`playlist_targets`, `radio_targets`, `relationships`) |
| 2 | Opportunity Inbox homepage | **MISSING** | `AdminHub.tsx` launcher pattern |
| 3 | Playlist Agent (unified pipeline) | **PARTIAL** | `playlist-research/batch`, `execute-pitch`, `pitch-status`, `playlist_targets` |
| 4 | Creator Agent | **MISSING** | IG DM infra (`ig-outreach`, `social_engagement_queue`) |
| 5 | Conversation Agent | **MISSING** | `instagram-messaging`, `telegram-webhook` |
| 6 | Radio Agent | **PARTIAL** | `radio_targets`, `radio-outreach.ts`, Apple spins |
| 7 | DJ Agent | **MISSING** | — |
| 8 | Press Agent | **MISSING** | — |
| 9 | Event Agent | **MISSING** | — |
| 10 | AI Opportunity Scoring | **PLACEHOLDER** | RIE deterministic score (`rie_relationship_score`) |
| 11 | Song Intelligence objects | **MISSING** | `tracks` (extend) |
| 12 | Song timestamp matching | **MISSING** | — |
| 13 | Relationship Memory | **PARTIAL** | RIE (`relationships`, `relationship_history`, `v_relationship_summary`) |
| 14 | Distribution Graph | **MISSING** | `overlap_score`/`similar_artists` hints |
| 15 | Fan Discovery (lookalike) | **PARTIAL / BLOCKED_BY_EXTERNAL_ACCESS** | `fan_profiles`, Meta CAPI, truth funnel |
| 16 | Creative Matching Engine | **MISSING** | `catalog-match`/`placement-match` (attribution only) |
| 17 | Referral Intelligence | **MISSING** | — |
| 18 | Learning Engine | **MISSING** | `fan_events`, `rie_recompute_scores` (one-shot) |

**Bottom line:** 0 of 18 are EXISTS_AND_WORKING as specified. 4 are PARTIAL (real reusable channel/relationship infra), 1 is PLACEHOLDER (deterministic relationship score, not opportunity score), 1 is PARTIAL+BLOCKED (lookalike needs Meta), and 12 are MISSING. Phase 1 builds the **unified data model + service layer + authenticated API + live inbox** that ties the PARTIAL assets together and makes the abstraction usable, without over-claiming the agents/graph/learning that come in Phases 2–6.
