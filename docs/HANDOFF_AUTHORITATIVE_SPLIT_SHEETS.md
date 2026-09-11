# Handoff — Authoritative Split-Sheet Builder & Controlled Delivery

## Final SHA

See tip of `cursor/split-sheet-authoritative-delivery-11d7` after merge commits below.

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
- `ops_settings` for delivery-policy seed
- `has_role(auth.uid(), 'admin')` RLS pattern
- Sync eligibility / research / control stack
- Ops actor matrix (`ops-actors.ts`) + `ACTION_SPEC` (`outreach-auth.ts`)
- `control-center-api` action router
- Admin shell (`AdminHub`, React admin routes)

## Files / migrations changed

- `supabase/migrations/20260911160000_authoritative_split_sheets.sql`
- `supabase/functions/_shared/split-sheets.ts`
- `supabase/functions/_shared/split-sheet-delivery.ts`
- `supabase/functions/_shared/split-sheets-authoritative.ts` (+ tests)
- `supabase/functions/_shared/sync-eligibility.ts`
- `supabase/functions/_shared/sync-research.ts`
- `supabase/functions/_shared/ops-actors.ts` / `outreach-auth.ts` / tests
- `supabase/functions/control-center-api/index.ts`
- `src/pages/admin/AdminSplitSheets.tsx`, `AdminHub.tsx`, `App.tsx`
- `src/integrations/supabase/types.ts` (manual extension)

## Schema & state model

**Lifecycle statuses:** `draft`, `awaiting_contributor_confirmation`, `partially_confirmed`, `ready_for_fendi_review`, `approved`, `final`, `superseded`, `disputed` (legacy statuses retained for migration).

**Document kinds (honest):**
- `agh_generated_summary` — AGH HTML ownership summary (**not** signed)
- `contributor_confirmed` — contributor confirmations recorded
- `uploaded_signed` — uploaded signed evidence
- `provider_signed` — reserved for future e-sign (not integrated)

Composition and master ownership are separate (`ownership_side` + `split_sheet_master_owners`).

**Atomicity:** `create_split_sheet_version` validates the full set, supersedes the prior current version without deleting its contributors, inserts the new version + all rows, and rolls back on any failure.

**Immutability:** triggers block in-place mutation of `final` sheets/contributors; corrections create a new version.

## Authorization matrix

| Actor | Draft / gaps | Edit shares | Finalize | Deliver | Grant delivery auth |
|---|---|---|---|---|---|
| Claude / claude_sync_discovery | yes | draft only | no | no | no |
| Grok playlist control | read | no | no | yes (final + authorized reason) | request only |
| Human admin | draft / evidence | draft | **no** | read history | no |
| Fendi (`ARTIST_USER_ID`) | yes | yes | **yes** | yes | **yes** |

Caller-supplied approval identity fields are stripped and ignored.

## Document storage

- Private bucket `rights-documents` (`public=false`)
- Short-lived signed URLs only (default TTL 900s)
- Every view / download / delivery audited in `rights_document_audit_events`
- Claude lacks delivery / signed-URL capabilities (no unnecessary PII download path)

## Sync-eligibility derivation

- Legacy `splits_ready=true` copied to `splits_ready_legacy` with `splits_ready_source=unverified_legacy`, then cleared
- Gate clears **only** when `splits_ready=true` **and** `splits_ready_source=authoritative_final`
- Set by `finalize_split_sheet_version` after Fendi finalize

## Grok delivery workflow

1. Availability check  
2. Request Fendi authorization when required  
3. Deliver with reason ∈ `{recipient_requested, opportunity_requires, fendi_authorized}`  
4. Log delivery + audit; record responses / follow-ups  

**Default policy:** `request_only`. Initial sync pitch never auto-attaches the full sheet.

## Test results

```text
deno test --allow-env --no-check \
  split-sheets-authoritative.test.ts ops-actors.test.ts sync-operating-stack.test.ts
→ 42 passed | 0 failed
```

Covers atomic replace preservation, finalize auth, Grok/Claude denials, no auto-attach, legacy boolean insufficient for eligibility, playlist stack still operational.

## Generated-type status

Manually extended. Regenerate from Lovable after SQL apply.

## Live migration required

**Yes** — paste `20260911160000_authoritative_split_sheets.sql` into **Lovable → SQL Editor**.

## Edge redeploy required

**Yes** — redeploy `control-center-api` via Lovable Edge Functions.

## Frontend publication

**Yes** — `/admin/split-sheets` needs frontend publish.

## Legal-signature status (honest)

**No e-signature provider is integrated.** Distinguish clearly:

- AGH-generated ownership summary
- Contributor-confirmed split sheet
- Uploaded signed split sheet

Never label unsigned generated HTML as “signed.”

## Non-send acceptance procedure

1. Apply migration in Lovable SQL Editor; confirm RPCs + `rights-documents` bucket.  
2. Redeploy `control-center-api`.  
3. Publish frontend; open `/admin/split-sheets`.  
4. Create a **draft** for the ops_settings-configured research track only (no title hard-coding).  
5. Confirm invalid totals are rejected without destroying the prior version.  
6. Confirm ordinary admin cannot finalize; Claude cannot finalize/deliver; Grok cannot edit shares.  
7. Confirm `draft_sync_pitch` returns `split_sheet_attached: false`.  
8. Confirm legacy `splits_ready` alone does not clear eligibility.  
9. **Do not** send sync pitches, deliver split sheets, alter Song DNA, mark eligibility live, or interrupt playlist submissions during acceptance.
