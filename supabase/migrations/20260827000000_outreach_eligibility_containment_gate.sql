-- AGH P0-A — Eligibility Containment Gate (schema half).
--
-- WHY THIS EXISTS
-- ---------------
-- AGH-001: "Meditate" reached the pitch composer with no track category and no
-- authored genre signal, and the only thing standing between it and a live send
-- was a fail-OPEN category gate ("absence is missing information, not a
-- disqualifier"). That rule was correct for the DFM outage it was written for
-- (verified targets with an empty playlist_categories) but it also let a track
-- with NO song intelligence at all address real curators. Caps, cooldowns and
-- the send window are capacity controls — none of them can answer "is this song
-- cleared to be pitched at all?".
--
-- This migration adds that answer as explicit, auditable per-track state, and it
-- is FAIL-CLOSED: the column default is `needs_song_intelligence`, so every
-- existing track and every future track is NOT eligible until something (a
-- human, via the artist-truth path) says otherwise. Only the two tracks Fendi
-- has verified on 2026-08-27 are backfilled to `eligible`.
--
-- NOTE ON MEDITATE'S GENRE. Meditate is artist-verified RAP / HIP-HOP — a
-- hip-hop CLUB record. Larry June lifestyle-wellness lane; production references
-- Kendrick Lamar "HUMBLE." and J. Cole "Two Six"; live categories rap_general +
-- rap_trap_hype.
--
-- GENRE vs CONTEXT — the distinction AGH-001 collapsed. "Club" is the CONTEXT
-- the record was built for (nightclub-floor energy, hard-hitting rap bars) and
-- is CORRECT. It is NOT a genre claim. The GENRE is rap/hip-hop, full stop.
-- An earlier migration (20260719000000_category_backfill_and_meditate.sql) read
-- "club" as a dance/electronic genre lane and tagged Meditate accordingly —
-- that GENRE assignment is WRONG and is the AGH-001 error itself. Nothing in
-- this file asserts, restates, or re-applies that lane for Meditate; it records
-- eligibility STATE only.
--
-- PROMOTION RULE (encoded here in the grants, mirrored in code)
-- -------------------------------------------------------------
-- Nothing on the automated pitching path may set a track to `eligible`.
-- Automation may only move a track to a MORE restrictive state. Returning a
-- track to `eligible` belongs to the artist-truth / human-clearance path and is
-- deliberately OUT OF SCOPE for P0-A. `public.tracks` has a SELECT policy for
-- `authenticated` and deliberately NO insert/update policy, so the only writer
-- is the service role (RLS-bypassing) — i.e. a reviewed edge function or a human
-- in the Lovable SQL editor. The send path only ever READS these columns.
--
-- APPLY ORDER (Lovable, gated — NOT performed by this commit)
-- -----------------------------------------------------------
--   1. Paste this file into Lovable -> SQL Editor and run it.
--   2. THEN redeploy execute-pitch + the playlist-agent functions.
-- The code half fails CLOSED if it is deployed before this migration lands: the
-- eligibility select errors, and the guard refuses the send with reason
-- `eligibility_schema_missing` rather than falling through to a send. That is
-- the safe failure, but it is a full send stop — so keep the order above.
--
-- Idempotent throughout: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The eligibility state machine.
-- ---------------------------------------------------------------------------
-- eligible                 -> cleared to be pitched to real curators.
-- needs_song_intelligence  -> we do not know enough about the song (no category /
--                             no genre lane / no verified pitch copy) to address a
--                             curator with it. THE FAIL-CLOSED DEFAULT.
-- no_genre_lane            -> song intelligence exists but does not map to a lane
--                             we can pitch into; nothing to send it to.
-- blocked                  -> explicitly barred (artist decision, rights, embargo).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'outreach_eligibility') then
    create type public.outreach_eligibility as enum (
      'eligible',
      'needs_song_intelligence',
      'no_genre_lane',
      'blocked'
    );
  end if;
end$$;

comment on type public.outreach_eligibility is
  'AGH P0-A containment gate: may this track be pitched to real curators at all? '
  'Only ''eligible'' permits a send. Default state is ''needs_song_intelligence'' '
  '(fail-closed). Automation may only move a track to a MORE restrictive state; '
  'promotion back to ''eligible'' is a human/artist-truth action.';

-- ---------------------------------------------------------------------------
-- 2. Columns on public.tracks. FAIL-CLOSED default.
-- ---------------------------------------------------------------------------
alter table public.tracks
  add column if not exists outreach_eligibility public.outreach_eligibility
    not null default 'needs_song_intelligence',
  add column if not exists eligibility_reason text,
  add column if not exists eligibility_source text,
  add column if not exists eligibility_set_by text,
  add column if not exists eligibility_set_at timestamptz,
  add column if not exists eligibility_si_version text;

comment on column public.tracks.outreach_eligibility is
  'AGH P0-A gate state. ONLY ''eligible'' permits an outreach send; every other '
  'value (including the ''needs_song_intelligence'' default) refuses at both the '
  'draft path (runDraftPitch) and the send path (execute-pitch handleEmailPitch). '
  'Read-only from the send path — the pitcher never writes this column.';

comment on column public.tracks.eligibility_reason is
  'Human-readable justification for the current outreach_eligibility value. '
  'Surfaced verbatim in the refusal payload and the skip log so an operator can '
  'see WHY a track was held without opening the database.';

comment on column public.tracks.eligibility_source is
  'What produced the current state: ''migration'' (this file), ''artist_review'' or '
  '''artist_review_<correction>_<date>'' (human clearance, optionally naming the '
  'specific correction it rests on), or the name of the automated check that '
  'DEMOTED it. Automation may write this only alongside a more restrictive state.';

comment on column public.tracks.eligibility_set_by is
  'Actor of record for the decision — a person/approval token for human clearance '
  '(e.g. ''fendi-approved-2026-08-27''), or a job identifier for an automated '
  'demotion. This is the audit trail for a money/reputation-path control.';

comment on column public.tracks.eligibility_set_at is
  'When the current outreach_eligibility value was set. NULL means the row has '
  'never been decided and is sitting on the fail-closed default.';

comment on column public.tracks.eligibility_si_version is
  'The Song Intelligence version/basis that justified the decision, so a state can '
  'be re-checked when SI changes. NULL on the fail-closed default (no SI ran yet).';

-- Index the gate column: every draft and every send reads it, and the operator
-- views filter on it ("what is being held, and why?").
create index if not exists tracks_outreach_eligibility_idx
  on public.tracks(outreach_eligibility);

-- ---------------------------------------------------------------------------
-- 3. Policy commentary. NO policy change is made or needed.
-- ---------------------------------------------------------------------------
-- The new columns inherit public.tracks RLS. tracks has exactly one policy —
-- SELECT for `authenticated` — and deliberately NO insert/update policy, so no
-- browser session can promote a track to `eligible`; only the service role can
-- write, i.e. a reviewed edge function or a human in the Lovable SQL editor.
-- That absence IS the enforcement of the promotion rule, so it is commented
-- rather than "fixed".
comment on policy "Authenticated read tracks" on public.tracks is
  'Read-only catalogue access for the operator UI. There is deliberately NO '
  'insert/update policy on public.tracks: combined with the AGH P0-A gate, that '
  'means outreach_eligibility can never be promoted to ''eligible'' from a client '
  'session — only by the service role (reviewed edge function or human SQL). '
  'Do not add an update policy here without re-reviewing the P0-A promotion rule.';

-- ---------------------------------------------------------------------------
-- 4. Backfill — the ONLY two tracks cleared on 2026-08-27.
-- ---------------------------------------------------------------------------
-- Both are artist-verified, but on DIFFERENT bases — do not collapse them:
--
--   Designed For Me (Control) -> house/club. Categories and short_pitch were
--     corrected in 20260719000000_category_backfill_and_meditate.sql and
--     artist-reviewed. That classification stands.
--
--   Meditate -> RAP / HIP-HOP, a hip-hop CLUB record ("a hip-hop club banger.
--     Hard-hitting rap bars built for the nightclub floor" — matching the
--     corrected tracks.short_pitch). Larry June lifestyle-wellness lane;
--     production references Kendrick Lamar "HUMBLE." and J. Cole "Two Six". Its
--     live categories are rap_general + rap_trap_hype. "Club" is CONTEXT and is
--     correct; the GENRE is rap/hip-hop. The dance/electronic genre lane that
--     same earlier migration assigned to Meditate was WRONG — that
--     mis-classification IS the AGH-001 error, and this file must never restate
--     or re-assert it.
--
-- SCOPE: this migration writes ONLY the eligibility columns. It does NOT insert
-- track_categories, does NOT set short_pitch, and does not touch genre/lane data
-- for either track. Correcting Meditate's categories/copy is the artist-truth
-- path's job, not this gate's.
--
-- Every other track in the catalogue stays on the fail-closed default and cannot
-- be pitched until a human clears it. Scoped by explicit name match so a future
-- track cannot be swept in by re-run.

update public.tracks
set outreach_eligibility  = 'eligible',
    eligibility_reason    = 'Artist-verified 2026-08-27: house/club categories and '
                            'authored short_pitch both corrected and reviewed; cleared '
                            'for curator outreach.',
    eligibility_source    = 'migration',
    eligibility_set_by    = 'fendi-approved-2026-08-27',
    eligibility_set_at    = now(),
    eligibility_si_version = 'si-2026-07-19-category-backfill'
where lower(name) like '%designed for me%';

-- Meditate: artist-verified RAP / HIP-HOP club record. "Club" is the CONTEXT it
-- was built for and is correct; the GENRE is rap/hip-hop. Cleared on that
-- corrected classification, NOT on the dance/electronic genre lane that caused
-- AGH-001.
update public.tracks
set outreach_eligibility  = 'eligible',
    eligibility_reason    = 'Artist-verified 2026-08-27: RAP / HIP-HOP club record — a '
                            'hip-hop club banger. Hard-hitting rap bars built for the '
                            'nightclub floor. Larry June lifestyle-wellness lane; '
                            'production references Kendrick Lamar "HUMBLE." and J. Cole '
                            '"Two Six". Live categories are rap_general + rap_trap_hype. '
                            '"Club" is the CONTEXT the record was made for, NOT a genre '
                            'claim — the genre is rap/hip-hop. AGH-001 remediation: '
                            'supersedes the prior dance/electronic genre mis-classification '
                            'that caused the incident. Eligible BECAUSE a human cleared it '
                            'on the corrected rap classification, not because the gate '
                            'defaulted open.',
    eligibility_source    = 'artist_review_rap_correction_2026-08-27',
    eligibility_set_by    = 'fendi-approved-2026-08-27',
    eligibility_set_at    = now(),
    eligibility_si_version = 'si-2026-08-27-meditate-rap-correction'
where lower(name) = 'meditate';

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION — run after applying; expect exactly the two cleared tracks.
-- ---------------------------------------------------------------------------
--   select name, outreach_eligibility, eligibility_source, eligibility_set_by,
--          eligibility_si_version, eligibility_set_at
--   from public.tracks
--   order by outreach_eligibility, name;
--
-- Cleared tracks (expect 2 — Designed For Me (Control), Meditate):
--   select count(*) from public.tracks where outreach_eligibility = 'eligible';
--
-- Everything else must be fail-closed (expect 0):
--   select count(*) from public.tracks
--   where outreach_eligibility not in ('eligible','needs_song_intelligence','no_genre_lane','blocked');

-- ---------------------------------------------------------------------------
-- ROLLBACK — paste into Lovable -> SQL Editor to undo this migration.
-- Drop the code half FIRST (redeploy execute-pitch + playlist-agent from a
-- commit without the guard); if the columns disappear while the guard is live,
-- the guard fails closed and ALL sends stop.
-- ---------------------------------------------------------------------------
-- begin;
--
-- drop index if exists public.tracks_outreach_eligibility_idx;
--
-- alter table public.tracks
--   drop column if exists eligibility_si_version,
--   drop column if exists eligibility_set_at,
--   drop column if exists eligibility_set_by,
--   drop column if exists eligibility_source,
--   drop column if exists eligibility_reason,
--   drop column if exists outreach_eligibility;
--
-- -- Safe only once no column of this type remains anywhere:
-- drop type if exists public.outreach_eligibility;
--
-- -- The policy comment is metadata only; clear it if you want a clean revert:
-- comment on policy "Authenticated read tracks" on public.tracks is null;
--
-- commit;
