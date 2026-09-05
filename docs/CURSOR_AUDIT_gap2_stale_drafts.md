# AUDIT — Stale drafts + remaining pitch-copy gaps

## Gap 1 (P1) — Approved drafts with obsolete pitch body

`execute-pitch` sends `draft.body` verbatim. The shared gate only checks that
track pitch copy *exists*. After `tracks.short_pitch` was filled for Meditate,
**709 approved Meditate drafts** that still contain the old house description
pass the gate and would send stale copy.

Designed For Me drafts that contain the same house phrase are **correct** for
that song — do not invalidate by string match alone.

### Durable fix (this branch)

1. Columns on `outreach_drafts`: `pitch_copy_source`, `pitch_copy_hash`, `template_id`
   (plus existing `song_dna_version_id`).
2. At draft time: resolve + hash + store.
3. At send: re-resolve, compare hash (or legacy body containment). Mismatch → **422**,
   never silent re-render.
4. Hub action `invalidate_stale_drafts` (`dry_run` default true) marks mismatches
   `superseded` by comparison against currently resolved copy.

**Ops:** merge + Lovable-redeploy `execute-pitch`, `send-pitch-email`, CCA before the
~15:20 UTC run. Then dry-run invalidate; regenerate + Grok-approve individually.
Do not blanket-release ~5k drafts.

## Gap 2 (P2) — `{{fit_reason}}` can surface lane copy

Dropped from allowed template placeholders. Fit stays on draft metadata only.

## Gap 3 (P2) — Two track contracts

`queue_instagram_pitch` now requires `track_id` (no title-only lookup), matching
`draft_pitch`.

## Gap 4 (P2) — Fan DM copy still in source

Still in `_shared/fan-dm-templates.ts`. Lower severity; follow-up to move behind
`pitch_templates` / `dm_templates` editor. Not blocking Meditate/DFM sends.

## Out of scope

No seeding of Song DNA / short_pitch / reference_artists. Do not rewrite the 96
historical `pitch_log` rows with old copy.
