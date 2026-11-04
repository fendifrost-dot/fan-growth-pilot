# Handoff — release lapsed pair cooldowns + verify-time contact policy (2026-11-04)

**Repo:** `fendifrost-dot/fan-growth-pilot` (Lovable-managed; project ref `vsemrziqxrrfcquxfnwd`).
**Source:** AGH playlist run log 2026-11-04, run `0100b7f9` (§6a, §6b, §8, §11) and 11-03 (§3, §4).
**Pre-flight:** `docs/AGENT_BOOTSTRAP.md` — all six answers unchanged. No SQL in this handoff.

## Where things stand

| Item | State | Evidence |
|---|---|---|
| Lapsed pair cooldown frees the pair (was stranded as `existing_pair_already_pitched`) | **CODED** | `supabase/functions/_shared/playlist-discovery-ops.ts` — `classifyExistingPlaylistTarget` |
| Pitch-log cooldown lookup aliases `ID` / `spotify:ID` / `spotify:playlist:ID` | **CODED** | same file — `pitchLogKeysFor`, `pitchCooldownExpiry` |
| Cooldown expiry computed like `agh_contact_policy` (`greatest(cooldown_until, sent_at + 90d)`) | **CODED** | same |
| Verify-time contact-policy check for existing targets (`deferred`, not `verified_eligible`) | **CODED** | `supabase/functions/_shared/playlist-discovery-mcp.ts` — `existingTargetPolicyDeferral` |
| Tool description updated | **CODED** | `supabase/functions/mcp-playlist-discovery/index.ts` |
| Standing rules docs updated (playlistlookup surface, skip pool, named defects) | **CODED** | `docs/agh-rules/*.md` |
| Tests | 742 Deno shared tests pass locally (`deno test --no-lock --no-check --allow-env --allow-read`); 6 new | `playlist-discovery-mcp.test.ts` (tail) |
| **Edge function live** | **NOT DONE** | needs Lovable → Edge Functions → redeploy |

Commit SHA: see `git log -1 -- docs/HANDOFF_PLAYLIST_COOLDOWN_RELEASE_2026-11-04.md` on `main`
after merge. Nothing in this handoff is verified until step 3 below is run from real output.

## What changed, in behaviour terms

Before: `submit_playlist_candidates` looked up `pitch_log` rows for the (playlist, track) pair
by **exact** `playlist_id`. If a `sent` row existed with `cooldown_until > now()` it deferred
`pair_cooldown` (correct). If a `sent` row existed with `cooldown_until` in the **past**, it
returned `existing_pair_already_pitched`, which the submit handler counts as a **duplicate**.
A pitched pair therefore never became eligible again. On 2026-11-04 the live Hub held
**196** such pairs (oldest lapsed 2026-08-28), 129 of them on `manually_verified` rows in the
re-verify pool — which is why that pool produced 0 drafts for five runs.

After:

- Every `sent` pitch for the pair is read under all three key shapes.
- Expiry per row = `max(cooldown_until, coalesce(sent_at, pitched_at) + 90 days)` — the same
  arithmetic the DB's `agh_contact_policy` uses at draft time.
- Latest expiry in the future → `deferred`, `code: pair_cooldown`, `retry_after` = that expiry,
  `pitch_log_id` set.
- Latest expiry in the past → `existing_verified_eligible` with
  `prior_pitch: { pitch_log_id, cooldown_lapsed_at }` so Grok sees the history.
- `sent` row with **no** usable date → still `existing_pair_already_pitched` (fail closed),
  now with `pitch_log_id` and a `detail` string.
- An existing target that classifies eligible is then run through `agh_contact_policy`
  (same RPC `create_playlist_draft_inventory` uses). A refusal is `deferred` with the
  policy's code (`cooldown_conflict`, `suppressed_curator`, …),
  `classification: existing_policy_deferred`, `retry_after`, `pitch_log_id`. If the RPC
  cannot be read the row stays eligible and the insert-time trigger still guards it.

Not changed: the DB policy, the draft path, cooldown length, Soundplate freeze, lane checks.

## Step 1 — merge to `main`

Open PR from this branch. CI runs the same Deno suite. Nothing is live at merge.

## Step 2 — redeploy (Lovable only)

**Lovable → Edge Functions → redeploy `mcp-playlist-discovery`.** It is the only function
that imports the changed modules. Publish is not needed (no `src/` changes). No SQL.

## Step 3 — verify from real output (not from the agent's claim)

1. Reconnect / refresh the Claude connector and read the `submit_playlist_candidates` tool
   description. **Expected:** it contains the sentence beginning `A pair whose 90-day pitch
   cooldown has lapsed is eligible again`. If it does not, the redeploy did not take.
2. In the next `playlist_discovery_begin` run, submit **one** re-verify-pool row that the
   11-04 log listed as `existing_pair_already_pitched` with a past date (any of the 19 with
   `cooldown_until` 2026-09-10 … 2026-10-20). **Expected, exactly one of:**
   - `verified_eligible_count: 1` and the entry carries `prior_pitch.cooldown_lapsed_at`
     equal to that past date (or `sent_at + 90d` if later) → fix live, pair released; or
   - `deferred[0].code` = `cooldown_conflict` / `pair_cooldown` with a **future**
     `retry_after` → fix live, this curator is still cooling on another playlist/channel
     (by design, rule 2.4); or
   - `duplicates[0].classification` = `existing_pair_already_pitched` with a **past**
     `cooldown_until` → **fix NOT live**. Stop and report; do not keep spending the pool.
3. Then `create_playlist_draft_inventory` on any released id. **Expected:** a draft row, not
   `policy_deferred_all`. If it is `policy_deferred_all` while submit said eligible, the
   verify-time policy check is not live or the RPC errored — report the response verbatim.

Report back: the tool-description check (yes/no), the single-row outcome with the raw
`deferred` / `duplicates` / `verified_eligible` entry, and the draft result.

## Guardrails

- Do not "fix" a surprising outcome by editing the classification; the outcome is the finding.
- Do not run `supabase` CLI or open a standalone Supabase dashboard (false wall).
- Do not re-spend the whole re-verify pool to test this: one row is the test.
- The released pairs are still subject to Grok review and to the DB's per-curator policy.

## Still open (Fendi decisions, from the 11-04 log)

1. playlistlookup free account (`docs/agh-rules/agh-playlist-supply-blockers.md` §1).
2. Stored-lane repair for 7 ids (§3).
3. Two weak-fit garage packets (§5).
4. Soundplate row retirement (pending since 10-22).
5. Whether the ~18 press/label/show rows (`b3_*`, `curator_*`, `label_*`, `show_*`,
   `soundcloud:*`) should be deactivated so they stop inflating `needs_reverify_count` — a
   data decision, not made here.
