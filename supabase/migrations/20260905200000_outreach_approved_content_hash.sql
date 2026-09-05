-- Documentation only — apply via Lovable → SQL Editor (paste, don't type).
-- Connected project ref: vsemrziqxrrfcquxfnwd
--
-- Phase 5 Song-DNA enforcement: store a SHA-256 of the exact outbound artefact
-- Grok/Fendi approved (track_id, song_dna_version_id, playlist_id, campaign_id,
-- channel, recipient, subject, full body, template_id). Send re-hashes and
-- requires an exact match; edits clear this column and revoke approval.
--
-- Does NOT invent other tables. pitch_copy_hash remains the pitch-text
-- provenance check; approved_content_hash is the full-artefact seal.

alter table public.outreach_drafts
  add column if not exists approved_content_hash text;

comment on column public.outreach_drafts.approved_content_hash is
  'SHA-256 hex of the approved outbound artefact (track/DNA/playlist/campaign/channel/recipient/subject/body/template). Cleared on content edits; required at send.';

create index if not exists outreach_drafts_approved_content_hash_idx
  on public.outreach_drafts (approved_content_hash)
  where approved_content_hash is not null;
