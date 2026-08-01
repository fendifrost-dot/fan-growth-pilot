# Opportunity Engine — Architecture (Phase 1)

Phase 1 delivers the **Minimum Viable Opportunity System**: a unified data model, a
deterministic service layer, an authenticated API, and a live operator inbox. It is
the spine that Phases 2–6 (discovery connectors, song-intelligence pipeline,
relationship graph, referral intelligence, learning) hang off. This document is the
map; `OPPORTUNITY_ENGINE_VERIFY.md` is the hands-on walkthrough.

## 1. The core idea

Every channel today is a silo: `playlist_targets`, `radio_targets`, `relationships`,
`fan_profiles`. The Opportunity Engine adds **one** abstraction on top:

- a **growth_entity** — anyone we could build a relationship with (a playlist, DJ,
  journalist, venue, fan, …), normalized and de-duplicated across platforms;
- a **growth_opportunity** — a scored, actionable thing to do with an entity *now*
  (pitch this song to this playlist; reply to this DM; send this clip to this DJ).

Opportunities carry their **evidence**, eight **score components**, a recommended
**song + clip + action + draft message**, and a **lifecycle**. Actions and outcomes
are logged so the score can be recomputed from what actually happened.

## 2. Layers

```
 Browser (operator)                   Edge (Deno)                    Postgres (Supabase)
┌────────────────────────┐   JWT   ┌────────────────────────┐     ┌──────────────────────┐
│ AdminOpportunities.tsx │ ─────►  │ opportunities-api      │ ──► │ growth_entities       │
│ (Opportunity Inbox)    │  Bearer │  · JWT + admin-role gate│ RLS │ growth_opportunities  │
│ opportunitiesApi.ts    │ ◄─────  │  · REST routing         │ svc │ growth_relationship_… │
└────────────────────────┘  JSON   │  · repository()         │ role│ song_intelligence_…   │
                                    └──────────┬─────────────┘     │ song_clips            │
                                               │ imports           │ opportunity_actions   │
                              ┌────────────────▼───────────────┐   │ opportunity_outcomes  │
                              │ src/lib/opportunities (shared) │   │ (+ tracks.duration)   │
                              │ types · scoring · normalization│   └──────────────────────┘
                              │ relationship-memory · outcomes │
                              │ creative-match · messaging     │
                              │ access · repository            │
                              └────────────────────────────────┘
                              one source of truth: Vite · vitest · Deno
```

### Service layer — `src/lib/opportunities/` (single source of truth)
Runtime-agnostic, dependency-free pure logic imported by the frontend, the vitest
suite, **and** the Deno edge function (verified with `deno check`). No module imports
a concrete Supabase client — the repository takes an **injected** client — which is
what lets the same code run in all three runtimes without drift.

| Module | Responsibility |
|---|---|
| `types.ts` | Entity/opportunity/score/outcome types; enum lists |
| `scoring.ts` | Deterministic 8-component scorer + configurable weights + composite |
| `normalization.ts` | Platform/handle/URL normalization; entity & opportunity dedupe keys |
| `relationship-memory.ts` | Fold relationship events → 0..100 strength + summary |
| `creative-match.ts` | Song-profile ↔ entity-taste fit (seeds audience match) |
| `outcomes.ts` | Legal status transitions; clip validation; outcome derivation & learning signals |
| `messaging.ts` | Deterministic recommended action + draft message |
| `access.ts` | Pure route authorization decision (unit-testable) |
| `repository.ts` | Wires the above to storage via an injected client |

### API — `supabase/functions/opportunities-api/`
A single Deno function doing **REST** routing on method + path. It authenticates
**in code**: every request needs a Supabase user JWT; reads allow any signed-in user,
**all mutations require the `admin` role** (`public.user_roles` / `has_role`). The
service-role key never leaves the server, and RLS denies direct PostgREST access to
these tables — so this function is the sole, auditable gate. This is a deliberate
improvement over `control-center-api`'s "URL secrecy" model.

Routes: `GET/POST /opportunities`, `GET /opportunities/stats`, `GET/PATCH
/opportunities/:id`, `POST /opportunities/:id/{approve,reject,snooze,status,
generate-action,record-outcome,override-score}`, `POST /entities`.

### UI — `src/pages/admin/AdminOpportunities.tsx`
The **Opportunity Inbox** at `/admin/opportunities` (added to the admin nav). Backed
by live API data. Each card shows source platform, entity, type, why-discovered,
evidence, total + eight component scores, recommended song/clip/action, the draft
message, status, and relationship summary — with approve/reject/snooze/edit/generate/
mark-contacted/response/conversion/record-outcome/open-source actions. Loading,
empty, and error states; filters (status/type/min-score/search/sort); pagination;
mobile-responsive. The client (`opportunitiesApi.ts`) attaches the user's JWT and
never touches a service-role key.

## 3. Scoring model (deterministic — no ML)

Eight components, each 0..100, stored **separately** from the composite so a human
can see *why*. Weights are configurable (`DEFAULT_WEIGHTS`, sum 1.00, but the blend
normalizes by the actual sum). `effort` and `risk` are "bad-is-high" and inverted in
the blend. Absent signals fall back to documented neutrals — the engine never invents
data. Human overrides pin a score (`score_overridden`/`manual_score`) while retaining
the computed components. There is **no** ML model and none is claimed.

**The closed loop (wired, not aspirational).** Recording an outcome writes a
`growth_relationship_event` mapped from the outcome type; `recalcScore` then
aggregates the entity's relationship memory back into the `relationship_score`
component, so the composite moves with real history: **outcome → relationship event →
memory → score**. `src/test/opportunities/integration.test.ts` asserts this loop end
to end. Weight-tuning from outcomes is the Phase-6 learning step; the plumbing exists now.

## 4. Reuse (not rebuild)

- **Songs** = existing `public.tracks` (extended with `duration_seconds`), not a new table.
- **Relationship memory** bridges to the existing RIE (`relationships`) via
  `growth_entities.relationship_id` and complements `relationship_history`.
- **Entities** bridge to `playlist_targets` / `radio_targets` via FK columns.
- **Auth** reuses the `user_roles` / `has_role` model and the `outreach-auth.ts` JWT
  pattern.
- Phase 2 discovery connectors will translate the existing playlist/radio/fan
  pipelines into `growth_opportunities` rather than replacing them.

## 4.5 Outreach model alignment (Organization → Contact → Conversation → Message → Outcome)

The outreach / reply-tracking / contact-intelligence layer that Phases 2+ will build
uses the model **Organization → Contact → Conversation → Message → Outcome** — which is
the same entity/relationship/outcome model this engine already has. Phase 1 makes the
schema **compatible** with it (migration §8.5) so that layer builds later **without a
redesign**. Nothing here is populated by Phase 1 code; it is shape, not behavior.

| Concept | Where it lives (Phase-1 shape) | Populated in Phase 1? |
|---|---|---|
| **Organization ↔ Contact** | `growth_entities.entity_type` gains `organization` + `contact`; `growth_entities.parent_entity_id` links a contact (email/handle/form) to its org. Outreach hangs off the **contact**, not the raw address. | Supported (API/seed can set it); a test asserts it |
| **Conversation** | new `growth_conversations` (thread id, channel, subject, `external_thread_id`, status, `last_message_at`) | Table exists; unpopulated |
| **Message** | `growth_relationship_events` made message-capable: `conversation_id`, `external_message_id`, `in_reply_to`, `subject`, `body_preview` (direction + channel already existed). A message is an event in a conversation. | Columns exist; unpopulated |
| **Outcome "why"** | `opportunity_outcomes.outcome_category` (nullable, CHECK): `no_response, rejected, redirect, wrong_contact, needs_follow_up, interested, requested_future_music, playlist_added, radio, press, collaboration, fan, other` | Column exists; `outcome_type` remains the lifecycle marker |
| **Contact intelligence** | new `growth_contact_intelligence` (one row per contact): status, confidence, `contact_quality_score`, preferred/secondary/alternative channel, `last_successful_reply_at`, `last_bounce_at`, `avg_response_days`, `redirect_history` | Table exists; **unpopulated (room, not build)** |

**Explicit extension points (deliberately NOT built in Phase 1):** many-to-many entity
membership (a freelance journalist across several publications) → a future
`growth_entity_relationships('member_of')` edge table; conversation/message ingestion
from email/IG/Telegram webhooks; and the contact-intelligence scoring job that fills
`growth_contact_intelligence`. These are Phase 2+ and are marked NOT_STARTED, not faked.

## 5. Security / RLS

All nine new tables (seven core + `growth_conversations` and
`growth_contact_intelligence` from §4.5) use the repo's **backend-table pattern** (RLS
on; service-role full access; anon and authenticated **denied** direct access). The browser cannot read
or write them directly — only the JWT-gated edge function can, and it authorizes every
request. No secrets are committed; `.env` remains untracked-by-intent and is never
staged.

## 6. Phase boundaries (honest scope)

Phase 1 is the data model + service + API + inbox. **Not** built yet (correctly marked
NOT_STARTED): the discovery agents (Creator/Conversation/Radio-as-opportunity/DJ/
Press/Event), the song-intelligence *pipeline* (tables exist; ingestion does not), the
distribution graph, fan-discovery/lookalike (blocked by Meta Ads Manager), creative
matching beyond the tag-overlap seed, referral intelligence, and the closed learning
loop. See `OPPORTUNITY_ENGINE_GAP_AUDIT.md` for the full status matrix.
