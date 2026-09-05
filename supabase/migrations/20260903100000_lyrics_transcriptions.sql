-- Lyrics transcriptions — manual upload/edit + provider-neutral adapter stub.
-- LOCKED §6: provider deferred. No paid vendor wired. Manual only for now.

begin;

create table if not exists public.lyrics_transcriptions (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  version_number integer not null,
  source text not null default 'manual'
    check (source in ('manual', 'provider_stub', 'import')),
  provider_id text,
  provider_job_id text,
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'superseded')),
  language text not null default 'en',
  plain_text text not null default '',
  timed_lines jsonb not null default '[]'::jsonb,
  storage_path text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (track_id, version_number)
);

create index if not exists lyrics_transcriptions_track_idx
  on public.lyrics_transcriptions (track_id);

comment on table public.lyrics_transcriptions is
  'Editable lyric records. Provider column is reserved; paid vendors deferred (Phase 0 §6).';
comment on column public.lyrics_transcriptions.provider_id is
  'Provider-neutral id when a vendor is authorized later. Null for manual uploads.';

alter table public.lyrics_transcriptions enable row level security;

drop policy if exists "Authenticated read lyrics_transcriptions" on public.lyrics_transcriptions;
create policy "Authenticated read lyrics_transcriptions"
  on public.lyrics_transcriptions for select to authenticated using (true);

drop policy if exists "Service role manages lyrics_transcriptions" on public.lyrics_transcriptions;
create policy "Service role manages lyrics_transcriptions"
  on public.lyrics_transcriptions for all to service_role using (true) with check (true);

drop policy if exists "Deny anon lyrics_transcriptions" on public.lyrics_transcriptions;
create policy "Deny anon lyrics_transcriptions"
  on public.lyrics_transcriptions for all to anon using (false);

grant select on public.lyrics_transcriptions to authenticated;
grant all on public.lyrics_transcriptions to service_role;

commit;
