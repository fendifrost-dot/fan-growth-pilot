-- Split sheets — generator + storage metadata. Contributor legal facts stay incomplete
-- until Fendi enters them (locked §5). Missing data = action items, not a code block.

begin;

create table if not exists public.split_sheets (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  version_number integer not null,
  status text not null default 'incomplete'
    check (status in ('incomplete', 'ready_for_signatures', 'signed', 'superseded')),
  title text,
  notes text,
  action_items jsonb not null default '[]'::jsonb,
  document_storage_path text,
  document_mime text,
  generated_html text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (track_id, version_number)
);

create table if not exists public.split_sheet_contributors (
  id uuid primary key default gen_random_uuid(),
  split_sheet_id uuid not null references public.split_sheets(id) on delete cascade,
  legal_name text,
  role text not null default 'writer'
    check (role in ('writer', 'producer', 'publisher', 'artist', 'other')),
  split_percent numeric,
  ipi_number text,
  pro_affiliation text,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists split_sheets_track_idx on public.split_sheets (track_id);
create index if not exists split_sheet_contributors_sheet_idx
  on public.split_sheet_contributors (split_sheet_id);

comment on table public.split_sheets is
  'Split-sheet generator output. Incomplete until legal names/roles/% entered by Fendi.';
comment on column public.split_sheets.action_items is
  'Machine-generated checklist of missing contributor/legal fields.';

alter table public.split_sheets enable row level security;
alter table public.split_sheet_contributors enable row level security;

drop policy if exists "Authenticated read split_sheets" on public.split_sheets;
create policy "Authenticated read split_sheets"
  on public.split_sheets for select to authenticated using (true);
drop policy if exists "Service role manages split_sheets" on public.split_sheets;
create policy "Service role manages split_sheets"
  on public.split_sheets for all to service_role using (true) with check (true);
drop policy if exists "Deny anon split_sheets" on public.split_sheets;
create policy "Deny anon split_sheets"
  on public.split_sheets for all to anon using (false);

drop policy if exists "Authenticated read split_sheet_contributors" on public.split_sheet_contributors;
create policy "Authenticated read split_sheet_contributors"
  on public.split_sheet_contributors for select to authenticated using (true);
drop policy if exists "Service role manages split_sheet_contributors" on public.split_sheet_contributors;
create policy "Service role manages split_sheet_contributors"
  on public.split_sheet_contributors for all to service_role using (true) with check (true);
drop policy if exists "Deny anon split_sheet_contributors" on public.split_sheet_contributors;
create policy "Deny anon split_sheet_contributors"
  on public.split_sheet_contributors for all to anon using (false);

grant select on public.split_sheets to authenticated;
grant select on public.split_sheet_contributors to authenticated;
grant all on public.split_sheets to service_role;
grant all on public.split_sheet_contributors to service_role;

commit;
