-- Ops incidents + Chief-of-Staff audit visibility.
-- Operator/service logged events for review without inventing music facts.

begin;

create table if not exists public.ops_incidents (
  id uuid primary key default gen_random_uuid(),
  severity text not null default 'info'
    check (severity in ('info', 'warn', 'error', 'critical')),
  category text not null default 'general',
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  track_id uuid references public.tracks(id) on delete set null,
  campaign_id uuid,
  related_entity text,
  related_id text,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved')),
  created_by uuid references auth.users(id) on delete set null,
  acknowledged_by uuid references auth.users(id) on delete set null,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ops_incidents_status_idx on public.ops_incidents (status, created_at desc);
create index if not exists ops_incidents_category_idx on public.ops_incidents (category, created_at desc);

alter table public.ops_incidents enable row level security;
drop policy if exists "Authenticated read ops_incidents" on public.ops_incidents;
create policy "Authenticated read ops_incidents"
  on public.ops_incidents for select to authenticated using (true);
drop policy if exists "Service role manages ops_incidents" on public.ops_incidents;
create policy "Service role manages ops_incidents"
  on public.ops_incidents for all to service_role using (true) with check (true);
drop policy if exists "Deny anon ops_incidents" on public.ops_incidents;
create policy "Deny anon ops_incidents"
  on public.ops_incidents for all to anon using (false);

grant select on public.ops_incidents to authenticated;
grant all on public.ops_incidents to service_role;

-- Press / EPK operating surface (metadata + asset pointers; no invented bios).
create table if not exists public.press_kits (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  one_liner text,
  bio_short text,
  bio_long text,
  press_email text,
  assets jsonb not null default '[]'::jsonb,
  links jsonb not null default '{}'::jsonb,
  notes text,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.private_license_evidence (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  label text not null,
  storage_path text,
  notes text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists private_license_evidence_track_idx
  on public.private_license_evidence (track_id);

alter table public.press_kits enable row level security;
alter table public.private_license_evidence enable row level security;

drop policy if exists "Authenticated read press_kits" on public.press_kits;
create policy "Authenticated read press_kits"
  on public.press_kits for select to authenticated using (true);
drop policy if exists "Service role manages press_kits" on public.press_kits;
create policy "Service role manages press_kits"
  on public.press_kits for all to service_role using (true) with check (true);
drop policy if exists "Deny anon press_kits" on public.press_kits;
create policy "Deny anon press_kits"
  on public.press_kits for all to anon using (false);

drop policy if exists "Authenticated read private_license_evidence" on public.private_license_evidence;
create policy "Authenticated read private_license_evidence"
  on public.private_license_evidence for select to authenticated using (true);
drop policy if exists "Service role manages private_license_evidence" on public.private_license_evidence;
create policy "Service role manages private_license_evidence"
  on public.private_license_evidence for all to service_role using (true) with check (true);
drop policy if exists "Deny anon private_license_evidence" on public.private_license_evidence;
create policy "Deny anon private_license_evidence"
  on public.private_license_evidence for all to anon using (false);

grant select on public.press_kits to authenticated;
grant select on public.private_license_evidence to authenticated;
grant all on public.press_kits to service_role;
grant all on public.private_license_evidence to service_role;

commit;
