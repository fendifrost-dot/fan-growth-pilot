-- Admin role system — prerequisite for authenticating campaign write actions.
--
-- There is NO role concept in this database today. Authorization is de-facto
-- single-operator: ARTIST_USER_ID env, falling back to "the first row in
-- profiles". Before any action can require an "admin role", the role has to
-- exist as a real DB object.
--
-- Deliberately a SEPARATE user_roles table, NOT a column on profiles. Existing
-- RLS lets a user UPDATE their own profiles row ("Users can update their own
-- profile"), so a role column there would be self-escalatable: any signed-in
-- user could grant themselves admin.
--
-- Run this in the Lovable SQL Editor BEFORE 20260718010000_pitch_campaigns_phase1.sql.

do $$ begin
  create type public.app_role as enum ('admin', 'operator');
exception when duplicate_object then null;
end $$;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),
  unique (user_id, role)
);

create index if not exists user_roles_user_idx on public.user_roles (user_id);

-- SECURITY DEFINER so a policy can call it without the caller needing select
-- rights on user_roles. search_path is pinned to defeat search_path hijacking.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  );
$$;

alter table public.user_roles enable row level security;

-- Readable by the owning user (so the UI can show "you are an admin"), but
-- writable ONLY by service_role. Grants must never be self-serve.
drop policy if exists "Users can read their own roles" on public.user_roles;
create policy "Users can read their own roles"
  on public.user_roles for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Service role manages roles" on public.user_roles;
create policy "Service role manages roles"
  on public.user_roles for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Deny anonymous access to user_roles" on public.user_roles;
create policy "Deny anonymous access to user_roles"
  on public.user_roles for all
  to anon
  using (false);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

-- Seed: the existing single operator becomes admin. Mirrors the fallback in
-- resolveArtistUserId() (control-center-api), so behaviour is unchanged for
-- Fendi while every NEW write action gains a real identity to check against.
-- If ARTIST_USER_ID is set to something other than the oldest profile, grant
-- that id admin manually after running this.
insert into public.user_roles (user_id, role)
select p.id, 'admin'::public.app_role
from public.profiles p
order by p.created_at asc nulls last
limit 1
on conflict (user_id, role) do nothing;
