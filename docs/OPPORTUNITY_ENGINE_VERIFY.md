# Opportunity Engine — Verification (Phase 1)

How to prove Phase 1 works, end to end. Two parts: (A) local, no-deploy checks that
run in this repo today, and (B) the live end-to-end flow after a Lovable deploy.

---

## A. Local checks (no deploy required)

Run from the repo root.

| Command | What it proves | Result on this branch |
|---|---|---|
| `npm run typecheck` | Frontend + service layer type-safe (`tsc -p tsconfig.app.json --noEmit`) | **PASS** (exit 0) |
| `deno check supabase/functions/opportunities-api/index.ts` | The edge function + its in-tree `_shared/opportunities` import resolve and type-check under Deno (module graph has 0 out-of-tree refs) | **PASS** (exit 0) |
| `npm run test` | Full vitest suite | 143 passed, **52/52 Opportunity Engine tests pass**; 2 pre-existing failures unrelated to this work (see note) |
| `npx vitest run src/test/opportunities` | Just the Opportunity Engine tests | **7 files, 52 tests, all pass** — incl. the seeded end-to-end integration test |
| `npm run lint:ci` | Opportunity Engine source lints clean | **PASS** (exit 0) |
| `npm run build` | Production build compiles (inbox included) | **PASS** |

> **Pre-existing test note (proven, not assumed).** `npm run test` reports 2 failing
> files — `src/test/dashboard-regression.test.tsx` and
> `src/test/og-metadata-deterministic.test.ts`. They exercise the Index dashboard and
> `get-og-metadata` — neither touched by this change. Verified by checking out the
> untouched base commit `230a189` in an isolated worktree and running the same two
> files: they fail identically there. This is a pre-existing repo baseline, not a
> regression. `lint:ci` is scoped to the Opportunity Engine surface for the same
> reason — repo-wide `eslint .` / `eslint src` has ~40 pre-existing violations in
> files this change does not touch (the browser/React eslint config also lints the
> Deno `supabase/functions`, which `deno check` covers instead).

### Test coverage map (DoD)

| Required test | File |
|---|---|
| Opportunity score calc | `src/test/opportunities/scoring.test.ts` |
| Duplicate prevention | `src/test/opportunities/repository.test.ts` + `normalization.test.ts` |
| Entity normalization | `src/test/opportunities/normalization.test.ts` + `repository.test.ts` |
| Status transitions | `src/test/opportunities/outcomes.test.ts` + `repository.test.ts` |
| Song clip validation | `src/test/opportunities/outcomes.test.ts` |
| Relationship aggregation | `src/test/opportunities/relationship-memory.test.ts` + `repository.test.ts` |
| Outcome recording | `src/test/opportunities/outcomes.test.ts` + `repository.test.ts` |
| RLS-sensitive route auth | `src/test/opportunities/access.test.ts` |
| **Seeded end-to-end integration** | `src/test/opportunities/integration.test.ts` |

---

## A′. Integration proof (MANDATORY — the seeded loop that actually runs)

Individual tests prove the pieces work; this proves they are **wired together**. Two
artifacts, both real:

1. **Automated integration test** — `src/test/opportunities/integration.test.ts`.
   Runs today under `npx vitest run src/test/opportunities/integration.test.ts` (no
   deploy). It drives ONE seeded workflow through the exact repository/service code
   the edge function calls:

   `song (tracks + song_intelligence_profiles + approved song_clips) → findOrCreateEntity
   → createOpportunity (scored: audience_match 90, composite > 0) → listOpportunities
   (the inbox's data source, with the entity embedded on the card) → generateAction
   (draft references the real song + playlist) → transition approve → contacted
   (audited in opportunity_actions) → recordOutcome responded → recordOutcome converted
   → growth_relationship_events gains "replied" + "converted" rows → relationship memory
   aggregates and feeds back into the opportunity's relationship_score (it rises from 0)
   → status = converted → stats reflect the live row.`

   Every arrow is an assertion. This is the closed loop: **outcome → relationship
   history → memory → score**.

2. **Live seed script** — `supabase/seed/opportunity_engine_demo_seed.sql`. Run it in
   the Lovable SQL editor **after** the migration to place ONE real, coherent row in
   the live inbox (`/admin/opportunities`) before Phase 2 discovery exists. Its score
   components are the exact output of `scoring.ts` for the documented inputs (verified
   via `deno eval`), not decorative numbers. Idempotent; not auto-applied (lives under
   `supabase/seed/`, not `supabase/migrations/`); removable by `dedupe_key`.

> **Live-data guarantee:** the inbox renders **database rows only** — there are no
> hard-coded demo cards in `AdminOpportunities.tsx`. If a card is on screen, it came
> from `growth_opportunities` via the authenticated API. Phase 1 populates that table
> manually / via this seed / via the API; Phase 2 adds automated discovery.

---

## B. Deploy (a live agent does this — you commit; you don't deploy)

Per the standing rule: **SQL goes to the Lovable SQL editor; edge functions redeploy
via Lovable.** The migration is *also* committed as the version-controlled source of
truth (`supabase/migrations/20260801000000_opportunity_engine_phase1.sql`).

1. **Apply the migration.** Paste `20260801000000_opportunity_engine_phase1.sql` into
   the Lovable SQL editor and run. It is idempotent and additive (safe to re-run).
2. **Redeploy the edge function** `opportunities-api` via Lovable. `config.toml`
   already declares it `verify_jwt = false` (auth is enforced in-code, stricter).
   - **Bundler-safe by construction:** the function imports the shared service layer
     **in-tree** from `../_shared/opportunities/…`. `deno info` shows the module graph
     no longer reaches outside `supabase/functions/` (0 `src/lib` refs), so Lovable's
     bundler has nothing out-of-tree to follow. `src/lib/opportunities/*` are thin
     re-export shims of those same physical modules for Vite/vitest — one source of
     truth, no divergent logic.
3. **Regenerate `src/integrations/supabase/types.ts`** (Lovable) so the new tables are
   typed for any future direct client access. Phase 1 does **not** depend on this — the
   inbox talks to the edge function, not PostgREST directly.
4. **(Optional) Seed one real row** for the live inbox: run
   `supabase/seed/opportunity_engine_demo_seed.sql` in the Lovable SQL editor. Then open
   `/admin/opportunities` and confirm the "Pitch Designed For Me to Deep House Vibes"
   card appears with its component scores — proof of live data end to end.

---

## C. End-to-end flow (the DoD walkthrough)

This traces the full lifecycle the DoD calls for. Steps use the authenticated API
(`{BASE}` = your Supabase URL; `{JWT}` = an admin user's access token). Song +
intelligence + clip rows are seeded via the Lovable SQL editor (Phase 2 adds a UI for
these); everything from "entity" onward is live API + the inbox UI.

**1–3 — Song, intelligence profile, approved clip** (SQL editor):
```sql
insert into public.tracks (name, status, duration_seconds)
  values ('Designed For Me', 'active', 200) returning id;   -- {SONG_ID}
insert into public.song_intelligence_profiles (track_id, bpm, musical_key, mode,
  energy, genre_tags, mood_tags)
  values ('{SONG_ID}', 122, 'A', 'minor', 0.7,
          array['deep house','melodic house'], array['nocturnal','euphoric']);
insert into public.song_clips (track_id, label, start_seconds, end_seconds, status)
  values ('{SONG_ID}', 'drop', 64, 88, 'approved');         -- validated: 0<=64<88<=200
```

**4 — Entity** (dedupe on normalized platform+id):
```bash
curl -X POST "{BASE}/functions/v1/opportunities-api/entities" \
  -H "Authorization: Bearer {JWT}" -H "Content-Type: application/json" \
  -d '{"entity_type":"playlist","name":"Deep House Vibes","platform":"spotify",
       "platform_external_id":"37iABC","metadata":{"genre_tags":["deep house"]}}'
# -> { "entity": { "id": "{ENTITY_ID}", ... }, "created": true }
```

**5–6 — Opportunity + score** (scored on create; deduped by entity|type|song):
```bash
curl -X POST "{BASE}/functions/v1/opportunities-api/opportunities" \
  -H "Authorization: Bearer {JWT}" -H "Content-Type: application/json" \
  -d '{"entity_id":"{ENTITY_ID}","opportunity_type":"playlist_pitch",
       "title":"Pitch Designed For Me to Deep House Vibes","source_platform":"spotify",
       "recommended_song_id":"{SONG_ID}","recommended_start_seconds":64,
       "recommended_end_seconds":88,"why_discovered":"Genre + mood match",
       "scoreInput":{"audienceFit":0.9,"audienceSize":50000,"warmth":0.4,"hasContact":true}}'
# -> 201 { "opportunity": { "opportunity_score": <n>, "audience_match_score": 90, ... }, "created": true }
# Re-POST the same body -> 200 { "created": false, "deduped": true }  (duplicate prevented)
```

**7 — Inbox:** open `/admin/opportunities`. The opportunity appears, sorted by score,
with all eight component bars, the recommended clip (1:04–1:28), and the evidence.

**8 — Generate action:** click **Generate action** (or
`POST /opportunities/{id}/generate-action`). A recommended action + draft message are
stored and shown; the message is editable and saved via `PATCH /opportunities/{id}`.

**9 — Approve → contacted → response → conversion:**
```bash
curl -X POST "{BASE}/.../opportunities/{id}/approve"  -H "Authorization: Bearer {JWT}"
curl -X POST "{BASE}/.../opportunities/{id}/status" -H "Authorization: Bearer {JWT}" \
     -H "Content-Type: application/json" -d '{"to":"contacted"}'
```

**10–11 — Record outcome → relationship memory → recalc:**
```bash
curl -X POST "{BASE}/.../opportunities/{id}/record-outcome" \
  -H "Authorization: Bearer {JWT}" -H "Content-Type: application/json" \
  -d '{"outcome_type":"responded","response_received":true}'
# advances status to "responded", writes opportunity_outcomes + opportunity_actions rows,
# and returns a recalced score.
curl -X POST "{BASE}/.../opportunities/{id}/record-outcome" \
  -H "Authorization: Bearer {JWT}" -H "Content-Type: application/json" \
  -d '{"outcome_type":"converted","converted":true,"conversion_value":250}'
# -> status "converted"; conversion_value captured; score recalced from realized signals.
```
Relationship signals accrue in `growth_relationship_events`; `GET /opportunities/{id}`
returns the aggregated relationship summary alongside the opportunity. Human override:
`POST /opportunities/{id}/override-score {"manual_score":95,"reason":"personal intro"}`
pins the score while retaining the computed components.

### Authorization checks (RLS-sensitive)
- No JWT → `401 Sign-in required` on every route.
- Signed-in non-admin → `GET` works; any mutation → `403 Admin role required`.
- Direct PostgREST access to `growth_*` tables from the browser → denied by RLS.

---

## D. Known limitations & external blockers (honest)

- **Discovery is manual in Phase 1.** No connector auto-populates the inbox yet; create
  opportunities via the API/SQL. Phase 2 wires the existing playlist/radio/fan pipelines
  into `growth_opportunities`.
- **Song intelligence & clips are seeded via SQL** (no ingestion/UI yet — Phase 2/3).
- **Lookalike/fan-discovery is blocked by Meta Ads Manager** (external); not attempted.
- **Scoring is deterministic**, not learned. `recalcScore` layers realized outcomes onto
  the stored components; a true learning loop (weight tuning) is Phase 6.
- **`types.ts` not yet regenerated** for the new tables (needs a Lovable step); the
  inbox does not depend on it.
- The migration and edge deploy are performed by the live agent via Lovable, not by this
  code session.
