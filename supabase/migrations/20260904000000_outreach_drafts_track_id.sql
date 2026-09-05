-- outreach_drafts.track_id — exact song identity on every draft (no title-only).
-- Complements campaign_id (already added in 20260718010000).

begin;

alter table public.outreach_drafts
  add column if not exists track_id uuid references public.tracks(id) on delete set null;

create index if not exists outreach_drafts_track_id_idx on public.outreach_drafts (track_id);

-- Backfill from metadata.track_id when present and valid.
update public.outreach_drafts d
set track_id = (d.metadata->>'track_id')::uuid
where d.track_id is null
  and d.metadata ? 'track_id'
  and (d.metadata->>'track_id') ~* '^[0-9a-f-]{36}$'
  and exists (
    select 1 from public.tracks t where t.id = (d.metadata->>'track_id')::uuid
  );

comment on column public.outreach_drafts.track_id is
  'Exact track UUID required for send. Title-only drafts are not sendable under the identity gate.';
comment on column public.outreach_drafts.campaign_id is
  'Active pitch campaign authorizing this draft. Required together with track_id on approve-and-send.';

commit;
