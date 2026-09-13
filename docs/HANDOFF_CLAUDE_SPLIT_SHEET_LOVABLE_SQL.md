# Claude handoff — apply sync + split-sheet delivery migrations via Lovable SQL Editor

**For:** Claude (browser agent) applying gated production SQL through Lovable.  
**Pinned commit:** `51d446658a38c4cc024b7ae6c6cc5b0432c087b2` on `cursor/sync-split-sheet-delivery-a9e7` (PR #30).  
**Written:** 2026-09-13  
**Parent docs:** [`HANDOFF_AUTHORITATIVE_SPLIT_SHEETS.md`](./HANDOFF_AUTHORITATIVE_SPLIT_SHEETS.md) · [`SUPABASE_ACCESS.md`](./SUPABASE_ACCESS.md) · [`AGENT_BOOTSTRAP.md`](./AGENT_BOOTSTRAP.md) · [`HANDOFF_SYNC_SPLIT_LIVE_ACCEPTANCE.md`](./HANDOFF_SYNC_SPLIT_LIVE_ACCEPTANCE.md)

This is a **runbook**, not approval. Do **not** apply SQL, redeploy, or publish until Fendi explicitly approves each task.

---

## 0. Authority

| | Action | Type | Approved? |
|---|---|---|---|
| **A** | Apply `20260911150000_sync_operating_stack.sql` if not already applied | production **write** | ⬜ pending Fendi |
| **B** | Apply `20260911160000_authoritative_split_sheets.sql` if not already applied | production **write** | ⬜ pending Fendi |
| **C** | Apply `20260912010000_split_sheet_master_owner_immutability.sql` if not already applied | production **write** | ⬜ pending Fendi |
| **D** | Apply `20260913120000_sync_split_delivery_corrections.sql` | production **write** | ⬜ pending Fendi |
| **E** | Run non-send acceptance SQL (read-only probes) | production **read** | ⬜ pending Fendi |
| **F** | Redeploy `control-center-api` via Lovable Edge Functions | production **deploy** | ⬜ pending Fendi |
| **G** | Publish frontend | production **publish** | ⬜ pending Fendi |

If A/B/C already succeeded on this project, **only D is new**. Then E. F and G follow successful D.

**Do NOT:**

- Send sync pitches, deliver split sheets, mark tracks sync-eligible, edit Song DNA, finalize sheets, or grant delivery authorization.
- Change live campaign status. Leave Designed For Me **paused / inactive / outside operating scope** for the first run. First live playlist/sync research run is the currently configured in-scope active campaign only (today that is the Meditate UUID in `ops_settings`, not a title literal).
- Open standalone supabase.com (unless Lovable itself deep-links you).
- Use `supabase` CLI / service-role keys / local SQL apply.
- Retype migration SQL by hand. **Paste, don’t type.**
- Treat admin role as Fendi.
- Treat a signed URL as delivered. Treat unverified evidence as signed. Treat a log row as a send.

---

## 1. Pre-flight (all six must pass)

1. Repo: `fendifrost-dot/fan-growth-pilot` (not `artistgrowthhub`).
2. Control plane: **Lovable**.
3. Database: **Lovable-managed Supabase** — SQL only via Lovable SQL Editor.
4. Project ref: **`vsemrziqxrrfcquxfnwd`**.
5. Canonical branch: `main` after this PR merges.
6. Source of truth: `supabase/migrations/`.

**Forbidden:** `standalone_supabase` · `supabase_cli` · `local_sql` · `external_supabase_project` · `archived_clone` · `stale_repo` · `service_role_assumption`.  
A `supabase` CLI `403` is a **false wall** — use Lovable.

Deep link (SQL Editor):

```
https://lovable.dev/projects/4778d2a5-781c-45e5-b165-9497cdba4918?view=more&subview=cloud&section=sql
```

Confirm Cloud UI shows project tied to ref **`vsemrziqxrrfcquxfnwd`**. If not → STOP.

---

## 2. Files to apply (exact checksums)

From repo root at the pinned commit:

| Order | Path | SHA256 | Notes |
|---|---|---|---|
| 1 | `supabase/migrations/20260911150000_sync_operating_stack.sql` | `838a5e3bacd7185321d2faea864fd769ae00a9ebb3056eb43fdd5ddadbd8f849` | Skip if already applied |
| 2 | `supabase/migrations/20260911160000_authoritative_split_sheets.sql` | `d2ab72ace026051b22ff295e28b571f2a105d0d729fc4cb943c141f8091e9bfe` | Skip if already applied. Checksum changed: swallowed `exception when others then null` wrappers removed |
| 3 | `supabase/migrations/20260912010000_split_sheet_master_owner_immutability.sql` | `854a796bef4fb747496bf2445b64537f49807c7137ad781f063a6985f5dfddd3` | Skip if already applied (unchanged) |
| 4 | `supabase/migrations/20260913120000_sync_split_delivery_corrections.sql` | `0730cbd040259ec3fd1d8fa353cd8abc233cf87758d01128b4cc6c6044e9e3f4` | **New corrective migration** |
| Verify | `docs/sql/split_sheet_non_send_acceptance.sql` | `bae5430ca84a5c610af5ef6258ce88ad54166ae1cc5893ec4959efe727a11f6b` | Read-only |

Verify before pasting:

```bash
sha256sum supabase/migrations/20260911150000_sync_operating_stack.sql
sha256sum supabase/migrations/20260911160000_authoritative_split_sheets.sql
sha256sum supabase/migrations/20260912010000_split_sheet_master_owner_immutability.sql
sha256sum supabase/migrations/20260913120000_sync_split_delivery_corrections.sql
sha256sum docs/sql/split_sheet_non_send_acceptance.sql
```

Mismatch → **STOP**. Do not apply.

### What D (`20260913120000`) adds

- Honest document kinds including `verified_signed`
- Delivery results: `logged | awaiting_manual_submission | sent | failed | blocked`
- Transport columns: provider message id/response, idempotency, requested/authorized by
- Evidence signer + object hash
- Outreach send truth: `send_idempotency_key`, `send_failed`, `awaiting_manual_submission`
- Expanded final-sheet immutability + verified-evidence protect trigger
- Seeds `operating_scope_track_ids` from existing `active_research` keys **without changing campaign statuses**
- Tightens track delivery policy to `request_only | proactive_allowed`

---

## 3. Apply order

Paste **one file at a time**. Wait until **Run** returns before reading results.

1. If A/B/C were never applied: A → B → C.
2. Always apply D when approved.
3. Then E (acceptance). Do not finalize, deliver, or send.
4. Then F: redeploy **`control-center-api`** via **Lovable → Edge Functions (Cloud)**. Never `supabase functions deploy`.
5. Then G: publish frontend so operator UI picks up restored generated types and readiness/delivery language.

### First-run operating scope (operator instruction only)

Do **not** mutate campaigns in SQL during this apply.

- Leave Designed For Me paused / `inactive` / outside `operating_scope_track_ids`.
- First research/draft run uses `active_research ∩ operating_scope_track_ids ∩ current approved DNA`.
- Only Fendi may change `ops_settings.sync_research_config` or call `set_sync_operating_scope`.

---

## 4. TASK E — non-send acceptance

Paste `docs/sql/split_sheet_non_send_acceptance.sql`.

Record at least:

| Check | Expected |
|---|---|
| create / finalize RPCs | `true` |
| tables listed | all eight names present |
| `tracks.name` (not `title`) in readiness probe | query succeeds |
| immutability triggers | four names present |
| `rights-documents` | `public = false` |
| `splits_ready = true` and source ≠ `authoritative_final` | **0** rows; report if any |
| signed-kind ready without verified evidence | **0** rows |
| email `delivery_result=sent` without `provider_message_id` | **0** rows |
| `anon_can_create` / `anon_can_finalize` | `false` |

**Do not** call `finalize_split_sheet_version`, create live deliveries, or mint public URLs.

---

## 5. Edge + frontend

**Redeploy:** `control-center-api` (split-sheet, delivery, sync research, sync control, daily-ops setting lock).

**Publish:** frontend so `src/integrations/supabase/types.ts` (restored split-sheet stack) is live.

Secrets: do **not** rotate or invent Resend keys. Test mode (`AGH_PROVIDER_TEST_MODE` / `AGH_TEST_MODE`) must stay available for non-send verification. Live Resend sends only after Grok requests + Fendi grants + provider acceptance.

---

## 6. Hard stops

1. Login / credential prompt.
2. Project ref ≠ `vsemrziqxrrfcquxfnwd`.
3. Standalone supabase.com without Lovable deep link.
4. Checksum mismatch.
5. SQL / deploy error.
6. Any urge to finalize, send, or “test” with a real pitch.
7. Changing Designed For Me (or any campaign) to active for convenience.

---

## 7. Report back

- Which tasks were approved vs executed.
- Checksums verified.
- Literal SQL success/error text.
- Literal acceptance-query results.
- Whether F/G were done (timestamps).
- Confirmation that no campaigns, Song DNA, secrets, or real outreach were touched.
