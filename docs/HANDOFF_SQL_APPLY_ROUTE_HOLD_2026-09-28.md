# Handoff — apply the 2026-09-27 playlist route SQL in Lovable (browser Claude agent)

**Who executes:** a Claude agent with browser access, working in the **Lovable** project for
`fan-growth-pilot` (Supabase project ref `vsemrziqxrrfcquxfnwd`).
**Why:** PR #40 (merge commit `c4951ea`) fixed false submission-route verification in code. This handoff applies
its database migration, previews the audit, holds the bad unsent packets, and reports back.
**Time:** about 15 minutes.

---

## 0. Hard rules (read first — stop if any would be broken)

1. **Lovable only.**
   - Use Lovable → **SQL Editor** for SQL and Lovable **chat** for redeploys.
   - **Never** open supabase.com, the Supabase dashboard, the Supabase CLI or any service-role/admin API.
   - A `supabase` CLI 403 is a false wall. Ignore it and use Lovable.
2. **Paste, don't type.** Copy SQL exactly as given; do not edit it.
3. **Do not send, approve or reject anything.** Grok owns review and sending. This task only installs
   functions and moves broken *unsent* packets into holding (repair) batches.
4. **Run the preview before the apply.** Apply only if the preview passes the checks in step 4.
5. **Never run** `delete`, `truncate`, `drop`, or any `update` or `insert` not listed here.
6. If anything errors or looks different from what is described below, **stop and report**. Don't improvise
   fixes.
7. The SQL Editor often shows only the **last** statement's result. When a block below has several `select`
   statements, run them **one at a time** and record each result. The exception is the migration file in step 2,
   which is run whole.

---

## 1. Pre-check (read-only)

Paste into the SQL Editor and run:

```sql
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'advance_agh_handoff_batch')      as advance_rpc_present,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'agh_route_hold_audit')          as audit_fn_already_present,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'playlist_targets'
       and column_name in ('path_verified','form_url','form_source_evidence','research_context','is_active')) as target_cols_present,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'agh_handoff_records'
       and column_name in ('submitted_at','packet','reviewed_by','approved_by')) as record_cols_present,
  (select count(*) from public.agh_handoff_records r
     join public.agh_handoff_batches b on b.id = r.batch_id
    where r.queue_state = 'AWAITING_GROK_REVIEW' and b.batch_kind = 'playlist')   as records_awaiting_review;
```

Expected result:
- `advance_rpc_present` = 1
- `target_cols_present` = 5
- `record_cols_present` = 4
- `audit_fn_already_present` = 0 or 1. A 1 means the migration was already applied. That's fine, because the
  migration is safe to re-run.

**Record `records_awaiting_review`** for the report.

**If any expected value differs, stop and report.**

---

## 2. Apply the migration

1. Open this URL in the browser. It is the exact file from `main`:
   `https://raw.githubusercontent.com/fendifrost-dot/fan-growth-pilot/main/supabase/migrations/20260927120000_route_hold_and_candidate_log.sql`
   If it doesn't load, use this page and click **Raw**:
   `https://github.com/fendifrost-dot/fan-growth-pilot/blob/main/supabase/migrations/20260927120000_route_hold_and_candidate_log.sql`.
   The file is about 460 lines. It starts with a `--` comment header and ends with `commit;`. Make sure the paste
   contains both ends.
2. Select all, copy, paste it into the Lovable SQL Editor as one script, and run it.
3. The script starts with `begin;` and ends with `commit;`. It only creates or replaces functions, and creates a
   table and index if they don't exist. **It does not hold or change any record.**

Expected result: success. A `NOTICE ... policy ... does not exist, skipping` message is normal.

Verify:

```sql
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('agh_route_failure_code','agh_route_hold_records','agh_route_hold_audit',
                     'agh_log_candidate_evaluation','agh_spotify_key_alias_report')
 order by 1;
select to_regclass('public.agh_playlist_candidate_evaluations') as candidate_log_table;
```

Expected: 5 function names, and `candidate_log_table` = `agh_playlist_candidate_evaluations`.
**If not, stop and report the error text.**

Rule sanity check (read-only; must return exactly these five values):

```sql
select
  public.agh_route_failure_code('web_form','auto_verified',true,null,null,null,
    'Spotify playlist by curator X. no submission route confirmed at time of check.',null,null)            as null_form,        -- missing_form_url
  public.agh_route_failure_code('web_form','auto_verified',true,null,
    'https://open.spotify.com/playlist/370YtLfVc3bwtUp3uhyyAO',null,'Spotify playlist by curator',null,null) as spotify_form,     -- spotify_url_as_form
  public.agh_route_failure_code('web_form','auto_verified',true,null,'https://dailyplaylists.com/',null,
    'Spotify playlist by curator Spot, surfaced in a search for rap playlists accepting free 2026 submissions.',null,null) as unlinked, -- evidence_not_linked_to_form
  coalesce(public.agh_route_failure_code('web_form','auto_verified',true,null,
    'https://dailyplaylists.com/submit-song/add-song',null,'DailyPlaylists free house list: Club Music 2025',null,null),'ok') as valid_form, -- ok
  coalesce(public.agh_route_failure_code('email','auto_verified',false,'curator@label.example',
    null,null,null,null,null),'ok')                                                                          as legacy_email;     -- ok
```

**If any value differs, stop and report.**

---

## 3. Preview the audit (read-only, no writes)

```sql
select jsonb_pretty(jsonb_build_object(
  'failing_record_count', a->'failing_record_count',
  'by_code',              a->'by_code'
)) from (select public.agh_route_hold_audit(false) as a) x;
```

Then get the per-batch and per-state breakdown:

```sql
select i->>'queue_state' as queue_state, i->>'channel' as channel, i->>'code' as code, count(*) as n
  from jsonb_array_elements(public.agh_route_hold_audit(false)->'records') i
 group by 1,2,3 order by 4 desc;

select i->>'batch_id' as batch_id, count(*) as failing
  from jsonb_array_elements(public.agh_route_hold_audit(false)->'records') i
 group by 1 order by 2 desc limit 40;
```

**Save all three outputs for the report.**

---

## 4. Decide: apply or stop

Apply (step 5) only if **all** of these are true:

- **Count:** `failing_record_count` is **between 1 and 400**.
- **Codes:** every code in `by_code` is one of:
  - `missing_form_url`, `spotify_url_as_form`, `platform_url_as_form`, `invalid_form_url`
  - `missing_form_evidence`, `evidence_negates_route`, `evidence_not_linked_to_form`
  - `missing_curator_email`, `invalid_curator_email`, `target_inactive`
  - `route_not_verified`, `no_route_channel`
  - `missing_ig_account`, `invalid_ig_account`, `missing_ig_evidence`
- **Known-bad batch present:** batch `2ec6577b-ad74-487f-a5c1-322043b3e205` appears in the per-batch list with
  **8** failing records. A different number is acceptable only if some of them were already handled; note it.
- **States:** no row in the breakdown has `queue_state` = `REJECTED_BY_GROK`, `AWAITING_AGH_IMPORT` or
  `IMPORTED_TO_AGH`. The audit excludes those, so seeing one means something is wrong.

**If any check fails, do not apply.** Stop and report the preview outputs.

---

## 5. Apply the holds

```sql
select jsonb_pretty(jsonb_build_object(
  'applied',        a->'applied',
  'failing',        a->'failing_record_count',
  'held_count',     a->'hold_result'->'held_count',
  'skipped',        a->'hold_result'->'skipped',
  'targets_marked', a->'targets_marked'
)) from (select public.agh_route_hold_audit(true) as a) x;
```

This does the following:
- Each failing **unsent** record moves into a Claude-side repair batch at `CLAUDE_BATCH_READY`, with
  `payload.route_hold_repair = true`, one per source batch.
- The prior batch, state and reviewer are kept in `packet.route_hold`.
- Failing targets get `path_verified = false` and a `ROUTE_HOLD:` note (their prior notes are kept).
- Valid records stay where they are.
- Submitted, sent, rejected and imported records are never touched.

Expected: `applied` = true, and `held_count` equals the preview's `failing_record_count` minus any `skipped`.

---

## 6. Verify (read-only)

```sql
-- repair batches created
select id, record_count, notes, created_at
  from public.agh_handoff_batches
 where payload->>'route_hold_repair' = 'true'
 order by created_at desc limit 40;

-- the known-bad batch: only valid records remain (3 expected)
select id, queue_state, record_count
  from public.agh_handoff_batches where id = '2ec6577b-ad74-487f-a5c1-322043b3e205';
select r.playlist_target_id, pt.form_url
  from public.agh_handoff_records r
  join public.playlist_targets pt on pt.playlist_id = r.playlist_target_id
 where r.batch_id = '2ec6577b-ad74-487f-a5c1-322043b3e205';

-- re-running the preview must now show 0 records outside repair batches
select count(*) as still_failing_outside_repair
  from jsonb_array_elements(public.agh_route_hold_audit(false)->'records') i
  join public.agh_handoff_batches b on b.id = (i->>'batch_id')::uuid
 where coalesce(b.payload->>'route_hold_repair','false') <> 'true';
```

Expected:
- `2ec6577b` keeps its queue state (`AWAITING_GROK_REVIEW` unless Grok has since moved it), with
  `record_count` = 3. The three remaining form URLs are all `https://dailyplaylists.com/submit-song/add-song`.
- `still_failing_outside_repair` = 0.

---

## 7. Spotify key-alias report (read-only)

```sql
select jsonb_pretty(public.agh_spotify_key_alias_report());
```

**Record `prefixed_rows`, `prefixed_manually_verified` and `collision_count`.**
- **Do not rename or merge any rows.** Collisions are resolved later through the normal dedupe process.

---

## 8. Redeploy edge functions (Lovable chat)

Paste into Lovable chat:

> Sync GitHub main (c4951ea / PR #40). Redeploy edge functions `mcp-playlist-discovery`, `control-center-api`,
> `execute-pitch`, `send-pitch-email`, `approve-draft`, `draft-pitch`, `playlist-admin-api`, `playlist-research`,
> `enrich-curator-contacts`, `schedule-follow-up`, `mcp-sync-discovery` only. Do not modify any code.
> Confirm which functions were redeployed.

Confirm Lovable lists all 11. **If any is missing, report which ones.**

---

## 9. Report back (paste this filled in)

```
SQL APPLY REPORT — 2026-09-28
Pre-check: advance_rpc_present=_ target_cols_present=_ record_cols_present=_ records_awaiting_review=_
Migration: applied OK / error: ___
Functions present: _/5   candidate_log_table: ___
Rule sanity: null_form=___ spotify_form=___ unlinked=___ valid_form=___ legacy_email=___
Preview: failing_record_count=___ by_code=___
  top batches: ___
Decision: applied / stopped (reason: ___)
Apply: held_count=___ skipped=___ targets_marked=___
Verify: 2ec6577b state=___ record_count=___ remaining form_urls=___ still_failing_outside_repair=___
Repair batches created: ___
Alias report: prefixed_rows=___ prefixed_manually_verified=___ collision_count=___
Redeploy: functions confirmed=___ missing=___
Anything unexpected: ___
```

## If something goes wrong

- **Migration error:** nothing is partially applied, because it is one transaction. Report the exact error text.
- **Apply error:** `agh_route_hold_records` moves records one at a time inside the audit call, so an error rolls
  back that whole call. Report the error; do not retry more than once.
- **Undoing a hold:** there is no bulk undo, and that is by design. Held records carry their `prior_batch_id` and
  `prior_queue_state`. They return to review once their route is re-verified with real evidence (Claude re-submits
  the candidate), followed by `advance_playlist_batches`.
