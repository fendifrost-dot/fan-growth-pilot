-- Hub sync/licensing outbound send attribution (analogous to playlist pitch_log).
-- Apply via Lovable SQL Editor (paste). Idempotent / additive.
-- Does NOT send email, alter Song DNA, or change sync eligibility gates.

begin;

alter table public.licensing_pitch_log
  add column if not exists approved_by text,
  add column if not exists approved_by_label text,
  add column if not exists approved_at timestamptz,
  add column if not exists sent_by text,
  add column if not exists sent_by_label text,
  add column if not exists sent_at timestamptz,
  add column if not exists resend_message_id text,
  add column if not exists draft_id uuid,
  add column if not exists subject text,
  add column if not exists email_body text,
  add column if not exists from_address text,
  add column if not exists dispatched_via text,
  add column if not exists song_dna_version_id uuid;

comment on column public.licensing_pitch_log.approved_by is
  'Server-stamped approver of the sync draft (never caller-supplied).';
comment on column public.licensing_pitch_log.sent_by is
  'Server-stamped sender of the Hub Resend execute (never caller-supplied).';
comment on column public.licensing_pitch_log.from_address is
  'Professional From header used on the Resend send (SYNC_FROM_EMAIL or FROM_EMAIL / pitches@fendifrost.com). Never Gmail.';
comment on column public.licensing_pitch_log.dispatched_via is
  'Transport path. Hub Resend sends use submit_sync_outreach. Manual register rows stay null.';
comment on column public.licensing_pitch_log.draft_id is
  'Optional sync_research_pitch_drafts.id for Hub-executed sends.';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'licensing_pitch_log_draft_id_fkey'
  ) then
    alter table public.licensing_pitch_log
      add constraint licensing_pitch_log_draft_id_fkey
      foreign key (draft_id) references public.sync_research_pitch_drafts(id)
      on delete set null;
  end if;
exception
  when undefined_table then
    raise notice 'sync_research_pitch_drafts absent — draft_id FK deferred';
end $$;

create unique index if not exists licensing_pitch_log_draft_id_uidx
  on public.licensing_pitch_log (draft_id)
  where draft_id is not null;

create index if not exists licensing_pitch_log_resend_message_idx
  on public.licensing_pitch_log (resend_message_id)
  where resend_message_id is not null;

commit;
