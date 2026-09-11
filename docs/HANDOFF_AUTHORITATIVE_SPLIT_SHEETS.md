# Handoff — Authoritative Split-Sheet Builder & Controlled Delivery

## Final SHA

See latest commit on branch `cursor/split-sheet-authoritative-delivery-11d7`.

## Pre-flight

| Check | Result |
|---|---|
| Repo | `fendifrost-dot/fan-growth-pilot` |
| Control plane | Lovable-managed Supabase only |
| Project ref | `vsemrziqxrrfcquxfnwd` |
| Canonical branch | `main` |
| Migrations SoT | `supabase/migrations/` |

## Existing components reused

- Live tables `split_sheets`, `split_sheet_contributors` (extended, not replaced)
- `ops_settings` delivery-policy seed
- `has_role(..., 'admin')` RLS pattern
- Sync eligibility / research / control stack from sync operating stack PR
- Ops actor matrix (`ops-actors.ts`) + `ACTION_SPEC` (`outreach-auth.ts`)
- `control-center-api` action router
- Admin shell (`AdminHub`, React admin routes)

## Files / migrations changed

- `supabase/migrations/20260911160000_authoritative_split_sheets.sql` — schema + atomic RPCs + private bucket + immutability triggers
- `supabase/functions/_shared/split-sheets.ts` — versioned builder, honest document kinds, Fendi finalize
- `supabase/functions/_shared/split-sheet-delivery.ts` — Grok delivery lane (`request_only` default)
- `supabase/functions/_shared/split-sheets-authoritative.ts` (+ tests)
- `supabase/functions/_shared/sync-eligibility.ts` — splits gate requires `splits_ready_source=authoritative_final`
- `supabase/functions/_shared/sync-research.ts` — initial pitch never attaches split sheet
- `supabase/functions/_shared/ops-actors.ts` / `outreach-auth.ts` / tests
- `supabase/functions/control-center-api/index.ts` — routes
- `src/pages/admin/AdminSplitSheets.tsx`, `AdminHub.tsx`, `App.tsx`
- `src/integrations/supabase/types.ts` — manual extension pending regenerate

## Schema & state model

**Lifecycle:** `draft` → `awaiting_contributor_confirmation` → `partially_confirmed` → `ready_for_fendi_review` → `approved` → `final` (or `disputed` / `superseded`).

**Document kinds (honest):**
- `agh_generated_summary` — AGH HTML ownership summary (**not** signed)
- `contributor_confirmed` — contributor confirmations recorded
- `uploaded_signed` — uploaded signed evidence
- `provider_signed` — future e-sign provider (not integrated)

**Composition vs master** stored separately (`ownership_side` + `split_sheet_master_owners`).

**Atomicity:** `create_split_sheet_version` validates → supersedes prior current → inserts new version + all contributors/owners in one function. Failure rolls back; prior valid set is never deleted first.

**Immutability:** triggers block in-place mutation of `final` sheets/contributors; corrections create a new version.

## Authorization matrix

| Actor | Draft / gap report | Edit shares | Finalize | Deliver | Approve delivery auth |
|---|---|---|---|---|---|
| Claude / claude_sync_discovery | yes | draft only | no | no | no |
| Grok playlist control | read | no | no | yes (final + authorized reason) | request only |
| Human admin | draft / evidence | draft | **no** | read history | no |
| Fendi (`ARTIST_USER_ID`) | yes | yes | **yes** | yes | **yes** |

Caller-supplied `approved_by` / `finalized_by` / Fendi identity is stripped and ignored.

## Document storage

- Private bucket `rights-documents` (`public=false`)
- No permanent public URLs; short-lived signed links (default TTL 900s from ops_settings)
- Every view / download / delivery writes `rights_document_audit_events`
- Claude must not download unnecessary contributor PII (delivery/signed-URL actions are capability-gated away from Claude)

## Sync-eligibility derivation

- Legacy `splits_ready=true` preserved as `splits_ready_legacy` and `splits_ready_source=unverified_legacy`, then cleared
- Gate clears **only** when `splits_ready=true` **and** `splits_ready_source=authoritative_final`
- Set by `finalize_split_sheet_version` after Fendi finalize + confirmations/evidence rules

## Grok delivery workflow

1. `get_split_sheet_delivery_availability`
2. If needed: `request_split_sheet_delivery_authorization` (Fendi grants)
3. `deliver_split_sheet_to_sync_contact` with reason ∈ `{recipient_requested, opportunity_requires, fendi_authorized}`
4. Logs delivery row + audit; records response / follow-up

**Default policy:** `request_only`. Initial sync pitch never auto-attaches the full sheet (operational readiness disclosure only).

## Test results

`deno test --allow-env --no-check` on:
- `split-sheets-authoritative.test.ts`
- `ops-actors.test.ts`
- `sync-operating-stack.test.ts`

**42 passed / 0 failed** (atomicity mocks, auth matrix, no auto-attach, legacy boolean does not clear gate, playlist stack untouched).

## Generated-type status

`src/integrations/supabase/types.ts` manually extended. After Lovable applies the migration, regenerate types from the connected project.

## Live migration required

**Yes.** Paste `supabase/migrations/20260911160000_authoritative_split_sheets.sql` into **Lovable → SQL Editor** (do not use standalone Supabase CLI/dashboard).

## Edge functions requiring redeploy

Redeploy via **Lovable → Edge Functions**:
- `control-center-api` (split-sheet + delivery actions + eligibility/pitch policy)

## Frontend publication

**Yes** — Admin Split Sheets UI (`/admin/split-sheets`) needs Lovable/frontend publish to be operator-visible.

## Legal-signature status (honest)

**No e-signature provider is integrated.** The system distinguishes:
- AGH-generated ownership summary
- Contributor-confirmed split sheet
- Uploaded signed split sheet

Unsigned generated HTML is **never** labeled “signed.”

## Non-send acceptance procedure

1. Apply migration in Lovable SQL Editor; confirm RPCs + `rights-documents` bucket exist.
2. Redeploy `control-center-api`.
3. Publish frontend; open `/admin/split-sheets`.
4. Create a **draft** version for the configured Meditate research track only (via ops_settings — do not hard-code).
5. Confirm invalid totals / duplicate contributors are rejected **without** destroying prior version.
6. Confirm ordinary admin **cannot** finalize; Claude **cannot** finalize/deliver; Grok **cannot** edit shares.
7. Confirm `draft_sync_pitch` returns `split_sheet_attached: false`.
8. Confirm legacy `splits_ready` alone does **not** clear eligibility.
9. **Do not** send sync pitches, deliver split sheets, modify Song DNA, mark eligibility live, or interrupt playlist submissions during acceptance.
