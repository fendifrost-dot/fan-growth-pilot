# TASK — Pitch copy decoupling (COMPLETE)

Status: **merged and audited** on `origin/main` (enforcement live after Lovable
redeploy 2026-09-04 23:37 UTC).

Acceptance (Claude audit):

1. No operational `deep-house groove` literals in send/draft paths.
2. Single render path; lane/playlist copy never fills `{{pitch}}`.
3. `pitch-copy.ts` resolution: approved DNA short_pitch → tracks.short_pitch → 422.
4. `draft_pitch` requires `track_id`.
5. Discovery references from track fields.
6. DB-backed `pitch_templates`.
7. IG path gated; enrichment does not invent pitch copy.
8. Draft-less inventing disabled on execute path.
9. Tests for 422-without-draft and track-copy precedence.

Follow-ups: see `CURSOR_AUDIT_gap2_stale_drafts.md` and `CURSOR_GAP5_song_dna_rls_lockout.md`.
