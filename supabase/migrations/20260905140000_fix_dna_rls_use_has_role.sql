-- P0: Song DNA / discovery RLS was checking JWT app_metadata.role = 'admin'.
-- Nothing in this project sets that claim. The real role model is user_roles +
-- public.has_role(uid, role), introduced in 20260718005000_admin_roles.sql.
--
-- Apply via Lovable SQL Editor (paste). Service-role edge functions already
-- bypass RLS; this unlocks authenticated admin clients and operator SQL.

begin;

-- song_dna_versions ----------------------------------------------------------
drop policy if exists song_dna_versions_admin_all on public.song_dna_versions;
create policy song_dna_versions_admin_all on public.song_dna_versions
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists song_dna_audit_admin_select on public.song_dna_audit_events;
create policy song_dna_audit_admin_select on public.song_dna_audit_events
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- Allow admins to insert audit rows from authenticated paths (mirrors versions).
drop policy if exists song_dna_audit_admin_insert on public.song_dna_audit_events;
create policy song_dna_audit_admin_insert on public.song_dna_audit_events
  for insert to authenticated
  with check (public.has_role(auth.uid(), 'admin'));

-- discovery_profiles ---------------------------------------------------------
drop policy if exists discovery_profiles_admin_all on public.discovery_profiles;
create policy discovery_profiles_admin_all on public.discovery_profiles
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists discovery_profile_audit_admin_select on public.discovery_profile_audit_events;
create policy discovery_profile_audit_admin_select on public.discovery_profile_audit_events
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists discovery_profile_audit_admin_insert on public.discovery_profile_audit_events;
create policy discovery_profile_audit_admin_insert on public.discovery_profile_audit_events
  for insert to authenticated
  with check (public.has_role(auth.uid(), 'admin'));

-- related DNA-era tables that shipped the same JWT predicate ----------------
drop policy if exists outreach_shadow_admin_select on public.outreach_decision_shadow_log;
create policy outreach_shadow_admin_select on public.outreach_decision_shadow_log
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists agh_config_audit_admin_select on public.agh_config_audit_events;
create policy agh_config_audit_admin_select on public.agh_config_audit_events
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists outreach_mismatch_overrides_admin_all on public.outreach_mismatch_overrides;
create policy outreach_mismatch_overrides_admin_all on public.outreach_mismatch_overrides
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

commit;
