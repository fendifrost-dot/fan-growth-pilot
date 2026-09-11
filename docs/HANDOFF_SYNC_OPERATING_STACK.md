# Sync operating stack — Lovable apply + live non-send acceptance

**Repo:** `fendifrost-dot/fan-growth-pilot`  
**Migration:** `supabase/migrations/20260911150000_sync_operating_stack.sql`  
**Do not:** activate other tracks, alter Song DNA, send sync outreach, or interrupt playlist submissions.

## Lovable apply (required)

1. **SQL** — paste migration `20260911150000_sync_operating_stack.sql` into Lovable → SQL Editor (paste, don’t type).
2. **Edge functions** — redeploy via Lovable → Edge Functions (Cloud):
   - `control-center-api`
   - `mcp-playlist-discovery` (OAuth scope/actor helper updates)
   - **new** `mcp-sync-discovery`
3. **Secrets** (Lovable project secrets):
   - `CLAUDE_SYNC_DISCOVERY_SECRET` — dedicated narrow secret (optional when using OAuth only)
   - `AGH_MCP_SYNC_DISCOVERY_URL` — optional explicit public base for the sync MCP
4. **Frontend** — publish so `/admin/mcp-sync-authorize` is live.
5. **Connector** — Fendi authorizes Claude sync MCP once (OAuth/PKCE); do **not** re-run credential acceptance daily after it passes.

## Config (no code change)

`ops_settings.sync_research_config`:

| Track ID | Label | Status |
|----------|-------|--------|
| `506ad12f-9e2e-450c-b2e9-f3d10670c015` | Meditate | `active_research` |
| `5d09da7e-98cf-4276-8dca-861d1fbbfa98` | Designed For Me (Control) | `inactive` |
| `dc36a2c5-f07e-40da-a1b4-0c46c67fadd8` | Neva Too Much Prada | `blocked` |

Change active track via Admin Daily Ops → ops_settings upsert (`upsert_ops_setting`), never by editing titles in code.

## Live non-send acceptance plan

1. Authorize sync MCP as Fendi → confirm tools list returns `get_sync_discovery_work` … `get_own_sync_batches`.
2. Call `get_sync_discovery_work` → only Meditate in `active_research_track_ids`; `may_draft_outreach` reflects server blockers (expected `false` until Fendi gate clears).
3. Submit one `agency_introduction` target + one dated `active_brief` → both persist; undated `active_brief` returns `active_brief_requires_deadline`.
4. Attempt `create_sync_drafts` while ineligible → `422 sync_eligibility_blocked` with precise blockers; research rows remain.
5. `advance_sync_batch` → durable `agh_handoff_batches` row `batch_kind=sync`, `AWAITING_GROK_REVIEW`.
6. As Grok: `list_sync_pending_drafts` / `review_sync_outreach` — **do not** call `submit_sync_outreach` in acceptance.
7. Confirm playlist MCP + a playlist station still operate unchanged.
8. Confirm Claude sync cannot call `approve_sync_eligibility` / `approve_sync_outreach` / playlist send tools.

## Authorization matrix (summary)

| Capability | Claude sync discovery | Grok playlist control | Fendi |
|---|---|---|---|
| Research / persist targets & opportunities | ✓ | read | ✓ |
| Draft sync pitch | ✓ (eligibility-gated) | — | ✓ |
| Approve / submit sync outreach | ✗ | ✓ (eligibility-gated) | ✓ |
| Approve sample / sync eligibility / DNA | ✗ | ✗ | ✓ |
| Playlist approve / send | ✗ | ✓ | ✓ |
