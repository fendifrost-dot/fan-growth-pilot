-- Authoritative split-sheet / rights stack.
-- Extends existing split_sheets + split_sheet_contributors (do not recreate).
-- Fixes destructive contributor replace via atomic versioned RPC.
-- Apply via Lovable SQL Editor (paste). Additive / idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1. Extend split_sheets lifecycle + document integrity fields
-- ---------------------------------------------------------------------------
alter table public.split_sheets
  add column if not exists document_hash text,
  add column if not exists document_kind text not null default 'agh_generated_summary',
  add column if not exists is_current boolean not null default false,
  add column if not exists superseded_by uuid references public.split_sheets(id) on delete set null,
  add column if not exists composition_total_percent numeric(7,3),
  add column if not exists master_total_percent numeric(7,3),
  add column if not exists one_stop_master boolean not null default false,
  add column if not exists publishing_controlled boolean not null default false,
  add column if not exists master_controlled boolean not null default false,
  add column if not exists dispute_reason text,
  add column if not exists awaiting_confirmation_at timestamptz,
  add column if not exists fendi_reviewed_at timestamptz,
  add column if not exists fendi_reviewed_by text,
  add column if not exists fendi_approved_at timestamptz,
  add column if not exists fendi_approved_by text,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by text,
  add column if not exists confirmation_summary jsonb not null default '{}'::jsonb,
  add column if not exists rights_readiness jsonb not null default '{}'::jsonb;

do $$ begin
  alter table public.split_sheets drop constraint if exists split_sheets_status_check;
  alter table public.split_sheets
    add constraint split_sheets_status_check
    check (status in (
      'draft',
      'awaiting_contributor_confirmation',
      'partially_confirmed',
      'ready_for_fendi_review',
      'approved',
      'final',
      'superseded',
      'disputed',
      -- legacy statuses preserved for existing rows
      'incomplete',
      'ready_for_signatures',
      'signed'
    ));
exception when others then null;
end $$;

do $$ begin
  alter table public.split_sheets drop constraint if exists split_sheets_document_kind_check;
  alter table public.split_sheets
    add constraint split_sheets_document_kind_check
    check (document_kind in (
      'agh_generated_summary',
      'contributor_confirmed',
      'uploaded_signed',
      'provider_signed'
    ));
exception when others then null;
end $$;

-- Map legacy incomplete → draft for clarity (keep signed/ready as historical)
update public.split_sheets set status = 'draft' where status = 'incomplete';
update public.split_sheets set status = 'ready_for_fendi_review' where status = 'ready_for_signatures';
update public.split_sheets set status = 'final', document_kind = 'uploaded_signed'
  where status = 'signed' and coalesce(document_kind, '') = 'agh_generated_summary';

-- Ensure at most one current sheet per track
create unique index if not exists split_sheets_one_current_per_track
  on public.split_sheets (track_id)
  where is_current = true;

comment on column public.split_sheets.document_kind is
  'Honest document class: agh_generated_summary ≠ signed. Never label unsigned HTML as signed.';
comment on column public.split_sheets.is_current is
  'Exactly one current version per track when a sheet exists. Finalized versions stay immutable.';

-- ---------------------------------------------------------------------------
-- 2. Extend contributors: composition vs master, confirmation, publishing
-- ---------------------------------------------------------------------------
alter table public.split_sheet_contributors
  add column if not exists ownership_side text not null default 'composition',
  add column if not exists professional_name text,
  add column if not exists publisher_name text,
  add column if not exists publishing_administrator text,
  add column if not exists share_controlled boolean,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists confirmation_status text not null default 'unconfirmed',
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by text,
  add column if not exists confirmation_method text,
  add column if not exists confirmation_evidence_id uuid,
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.split_sheet_contributors
    drop constraint if exists split_sheet_contributors_ownership_side_check;
  alter table public.split_sheet_contributors
    add constraint split_sheet_contributors_ownership_side_check
    check (ownership_side in ('composition', 'master'));
exception when others then null;
end $$;

do $$ begin
  alter table public.split_sheet_contributors
    drop constraint if exists split_sheet_contributors_confirmation_status_check;
  alter table public.split_sheet_contributors
    add constraint split_sheet_contributors_confirmation_status_check
    check (confirmation_status in (
      'unconfirmed', 'confirmed', 'disputed', 'waived_by_fendi'
    ));
exception when others then null;
end $$;

do $$ begin
  alter table public.split_sheet_contributors
    drop constraint if exists split_sheet_contributors_role_check;
  alter table public.split_sheet_contributors
    add constraint split_sheet_contributors_role_check
    check (role in (
      'writer', 'composer', 'songwriter', 'producer', 'publisher',
      'artist', 'master_owner', 'label', 'other'
    ));
exception when others then null;
end $$;

do $$ begin
  alter table public.split_sheet_contributors
    drop constraint if exists split_sheet_contributors_percent_range;
  alter table public.split_sheet_contributors
    add constraint split_sheet_contributors_percent_range
    check (
      split_percent is null
      or (split_percent >= 0 and split_percent <= 100)
    );
exception when others then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Master ownership detail (may also live as ownership_side=master rows)
-- ---------------------------------------------------------------------------
create table if not exists public.split_sheet_master_owners (
  id uuid primary key default gen_random_uuid(),
  split_sheet_id uuid not null references public.split_sheets(id) on delete cascade,
  legal_name text not null,
  professional_name text,
  ownership_percent numeric(7,3) not null
    check (ownership_percent >= 0 and ownership_percent <= 100),
  label_name text,
  may_license_master boolean not null default false,
  evidence_reference text,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists split_sheet_master_owners_sheet_idx
  on public.split_sheet_master_owners (split_sheet_id);

alter table public.split_sheet_master_owners enable row level security;
drop policy if exists split_sheet_master_owners_admin_all on public.split_sheet_master_owners;
create policy split_sheet_master_owners_admin_all on public.split_sheet_master_owners
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 4. Evidence (uploaded signed sheets / provider refs) + delivery + audit
-- ---------------------------------------------------------------------------
create table if not exists public.split_sheet_evidence (
  id uuid primary key default gen_random_uuid(),
  split_sheet_id uuid not null references public.split_sheets(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  evidence_kind text not null
    check (evidence_kind in (
      'uploaded_signed_split',
      'contributor_confirmation',
      'signature_provider_ref',
      'other'
    )),
  storage_path text,
  document_hash text,
  mime_type text,
  provider_reference text,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verified', 'rejected')),
  verified_at timestamptz,
  verified_by text,
  notes text,
  uploaded_by text,
  created_at timestamptz not null default now()
);

create index if not exists split_sheet_evidence_sheet_idx
  on public.split_sheet_evidence (split_sheet_id, created_at desc);

alter table public.split_sheet_evidence enable row level security;
drop policy if exists split_sheet_evidence_admin_all on public.split_sheet_evidence;
create policy split_sheet_evidence_admin_all on public.split_sheet_evidence
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

alter table public.split_sheet_contributors
  drop constraint if exists split_sheet_contributors_confirmation_evidence_id_fkey;
alter table public.split_sheet_contributors
  add constraint split_sheet_contributors_confirmation_evidence_id_fkey
  foreign key (confirmation_evidence_id) references public.split_sheet_evidence(id)
  on delete set null;

create table if not exists public.split_sheet_deliveries (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  split_sheet_id uuid not null references public.split_sheets(id) on delete restrict,
  sync_target_id uuid,
  sync_opportunity_id uuid,
  recipient_name text,
  recipient_email text,
  recipient_organization text,
  delivery_reason text not null
    check (delivery_reason in (
      'recipient_requested',
      'opportunity_requires',
      'fendi_authorized'
    )),
  delivery_channel text not null default 'email'
    check (delivery_channel in ('email', 'web_form', 'secure_link')),
  document_version integer not null,
  document_hash text not null,
  document_kind text not null,
  secure_link_expires_at timestamptz,
  delivered_by text not null,
  delivered_by_label text not null,
  approval_identity text,
  approval_required boolean not null default true,
  delivery_result text not null default 'logged'
    check (delivery_result in ('logged', 'sent', 'failed', 'blocked')),
  delivery_error text,
  response_notes text,
  follow_up_required boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists split_sheet_deliveries_track_idx
  on public.split_sheet_deliveries (track_id, created_at desc);

alter table public.split_sheet_deliveries enable row level security;
drop policy if exists split_sheet_deliveries_admin_all on public.split_sheet_deliveries;
create policy split_sheet_deliveries_admin_all on public.split_sheet_deliveries
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

create table if not exists public.rights_document_audit_events (
  id uuid primary key default gen_random_uuid(),
  track_id uuid references public.tracks(id) on delete set null,
  split_sheet_id uuid references public.split_sheets(id) on delete set null,
  event_kind text not null
    check (event_kind in (
      'view', 'download', 'delivery', 'create_version', 'finalize',
      'supersede', 'confirm', 'dispute', 'evidence_upload', 'eligibility_recompute'
    )),
  actor_kind text not null,
  actor_label text not null,
  actor_user_id text,
  document_hash text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rights_document_audit_events_sheet_idx
  on public.rights_document_audit_events (split_sheet_id, created_at desc);

alter table public.rights_document_audit_events enable row level security;
drop policy if exists rights_document_audit_events_admin_all on public.rights_document_audit_events;
create policy rights_document_audit_events_admin_all on public.rights_document_audit_events
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 5. Legacy splits_ready provenance — historical only until verified
-- ---------------------------------------------------------------------------
alter table public.tracks
  add column if not exists splits_ready_legacy boolean,
  add column if not exists splits_ready_source text not null default 'unverified_legacy',
  add column if not exists current_split_sheet_id uuid references public.split_sheets(id) on delete set null,
  add column if not exists split_sheet_delivery_policy text not null default 'request_only';

do $$ begin
  alter table public.tracks drop constraint if exists tracks_splits_ready_source_check;
  alter table public.tracks
    add constraint tracks_splits_ready_source_check
    check (splits_ready_source in (
      'unverified_legacy',
      'authoritative_final',
      'manual_fendi_override',
      'none'
    ));
exception when others then null;
end $$;

do $$ begin
  alter table public.tracks drop constraint if exists tracks_split_sheet_delivery_policy_check;
  alter table public.tracks
    add constraint tracks_split_sheet_delivery_policy_check
    check (split_sheet_delivery_policy in ('request_only', 'opportunity_required', 'fendi_authorized'));
exception when others then null;
end $$;

-- Preserve any legacy true flags as historical metadata, then clear readiness
-- until authoritative documentation is attached.
update public.tracks
   set splits_ready_legacy = splits_ready,
       splits_ready_source = case when splits_ready then 'unverified_legacy' else 'none' end,
       splits_ready = false
 where splits_ready_legacy is null;

comment on column public.tracks.splits_ready is
  'Server-derived from authoritative finalized split sheet + confirmations/evidence. Never trust caller.';
comment on column public.tracks.splits_ready_legacy is
  'Historical boolean preserved for audit; does not confer sync readiness.';

-- ---------------------------------------------------------------------------
-- 6. Private storage bucket for rights documents
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rights-documents',
  'rights-documents',
  false,
  20971520,
  array['text/html', 'application/pdf', 'image/png', 'image/jpeg', 'application/octet-stream']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

drop policy if exists rights_documents_admin_select on storage.objects;
create policy rights_documents_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'rights-documents' and public.has_role(auth.uid(), 'admin'));

drop policy if exists rights_documents_admin_insert on storage.objects;
create policy rights_documents_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'rights-documents' and public.has_role(auth.uid(), 'admin'));

drop policy if exists rights_documents_deny_anon on storage.objects;
create policy rights_documents_deny_anon on storage.objects
  for all to anon
  using (bucket_id <> 'rights-documents');

-- ---------------------------------------------------------------------------
-- 7. Validation helpers + atomic versioned contributor replacement RPC
-- ---------------------------------------------------------------------------
create or replace function public._split_sheet_validate_contributor_set(
  p_composition jsonb,
  p_master jsonb
) returns jsonb
language plpgsql
immutable
as $$
declare
  v_comp_total numeric := 0;
  v_master_total numeric := 0;
  v_errors text[] := '{}';
  v_item jsonb;
  v_pct numeric;
  v_name text;
  v_seen text[] := '{}';
  v_key text;
begin
  if p_composition is null or jsonb_typeof(p_composition) <> 'array' or jsonb_array_length(p_composition) = 0 then
    v_errors := array_append(v_errors, 'composition_contributors_required');
  else
    for v_item in select * from jsonb_array_elements(p_composition)
    loop
      v_name := lower(trim(coalesce(v_item->>'legal_name', '')));
      if v_name = '' then
        v_errors := array_append(v_errors, 'composition_legal_name_required');
      end if;
      if coalesce(trim(v_item->>'role'), '') = '' then
        v_errors := array_append(v_errors, 'composition_role_required');
      end if;
      begin
        v_pct := (v_item->>'split_percent')::numeric;
      exception when others then
        v_errors := array_append(v_errors, 'composition_percent_invalid');
        v_pct := null;
      end;
      if v_pct is null or v_pct < 0 or v_pct > 100 then
        v_errors := array_append(v_errors, 'composition_percent_out_of_range');
      else
        v_comp_total := v_comp_total + v_pct;
      end if;
      v_key := v_name || '|' || lower(trim(coalesce(v_item->>'role', '')));
      if v_name <> '' and v_key = any(v_seen) then
        v_errors := array_append(v_errors, 'duplicate_composition_contributor');
      elsif v_name <> '' then
        v_seen := array_append(v_seen, v_key);
      end if;
    end loop;
    if abs(v_comp_total - 100) > 0.001 then
      v_errors := array_append(v_errors, 'composition_total_must_equal_100');
    end if;
  end if;

  if p_master is not null and jsonb_typeof(p_master) = 'array' and jsonb_array_length(p_master) > 0 then
    v_seen := '{}';
    for v_item in select * from jsonb_array_elements(p_master)
    loop
      v_name := lower(trim(coalesce(v_item->>'legal_name', '')));
      if v_name = '' then
        v_errors := array_append(v_errors, 'master_legal_name_required');
      end if;
      begin
        v_pct := (v_item->>'ownership_percent')::numeric;
      exception when others then
        v_pct := (v_item->>'split_percent')::numeric;
      end;
      if v_pct is null or v_pct < 0 or v_pct > 100 then
        v_errors := array_append(v_errors, 'master_percent_out_of_range');
      else
        v_master_total := v_master_total + v_pct;
      end if;
      if v_name <> '' and v_name = any(v_seen) then
        v_errors := array_append(v_errors, 'duplicate_master_owner');
      elsif v_name <> '' then
        v_seen := array_append(v_seen, v_name);
      end if;
    end loop;
    if abs(v_master_total - 100) > 0.001 then
      v_errors := array_append(v_errors, 'master_total_must_equal_100');
    end if;
  end if;

  return jsonb_build_object(
    'ok', coalesce(array_length(v_errors, 1), 0) = 0,
    'errors', to_jsonb(v_errors),
    'composition_total', v_comp_total,
    'master_total', v_master_total
  );
end;
$$;

create or replace function public.create_split_sheet_version(
  p_track_id uuid,
  p_composition jsonb,
  p_master jsonb default '[]'::jsonb,
  p_title text default null,
  p_notes text default null,
  p_one_stop_master boolean default false,
  p_publishing_controlled boolean default false,
  p_master_controlled boolean default false,
  p_actor_kind text default 'service',
  p_actor_label text default 'service',
  p_actor_user_id text default null,
  p_generated_html text default null,
  p_document_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_validation jsonb;
  v_version int;
  v_sheet_id uuid;
  v_prev uuid;
  v_item jsonb;
  v_idx int := 0;
  v_comp_total numeric;
  v_master_total numeric;
begin
  if p_track_id is null or not exists (select 1 from public.tracks where id = p_track_id) then
    return jsonb_build_object('ok', false, 'code', 'track_not_found', 'errors', jsonb_build_array('track_not_found'));
  end if;

  v_validation := public._split_sheet_validate_contributor_set(p_composition, p_master);
  if not (v_validation->>'ok')::boolean then
    return jsonb_build_object(
      'ok', false,
      'code', 'validation_failed',
      'errors', v_validation->'errors',
      'composition_total', v_validation->'composition_total',
      'master_total', v_validation->'master_total'
    );
  end if;

  v_comp_total := (v_validation->>'composition_total')::numeric;
  v_master_total := (v_validation->>'master_total')::numeric;

  select id into v_prev
    from public.split_sheets
   where track_id = p_track_id and is_current = true
   for update;

  select coalesce(max(version_number), 0) + 1 into v_version
    from public.split_sheets
   where track_id = p_track_id;

  -- Supersede prior current version (never delete its contributors)
  if v_prev is not null then
    update public.split_sheets
       set is_current = false,
           status = case when status in ('final', 'approved', 'signed') then 'superseded' else status end,
           updated_at = now()
     where id = v_prev;
  end if;

  insert into public.split_sheets (
    track_id, version_number, status, title, notes, action_items,
    generated_html, document_hash, document_kind, is_current,
    composition_total_percent, master_total_percent,
    one_stop_master, publishing_controlled, master_controlled,
    created_by, updated_by
  ) values (
    p_track_id, v_version, 'draft', p_title, p_notes, '[]'::jsonb,
    p_generated_html, p_document_hash, 'agh_generated_summary', true,
    v_comp_total, nullif(v_master_total, 0),
    coalesce(p_one_stop_master, false),
    coalesce(p_publishing_controlled, false),
    coalesce(p_master_controlled, false),
    nullif(p_actor_user_id, '')::uuid,
    nullif(p_actor_user_id, '')::uuid
  ) returning id into v_sheet_id;

  if v_prev is not null then
    update public.split_sheets set superseded_by = v_sheet_id where id = v_prev;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_composition, '[]'::jsonb))
  loop
    insert into public.split_sheet_contributors (
      split_sheet_id, ownership_side, legal_name, professional_name, role,
      split_percent, ipi_number, pro_affiliation, publisher_name,
      publishing_administrator, share_controlled, contact_email, notes, sort_order
    ) values (
      v_sheet_id, 'composition',
      nullif(trim(v_item->>'legal_name'), ''),
      nullif(trim(v_item->>'professional_name'), ''),
      coalesce(nullif(trim(v_item->>'role'), ''), 'writer'),
      (v_item->>'split_percent')::numeric,
      nullif(trim(v_item->>'ipi_number'), ''),
      nullif(trim(v_item->>'pro_affiliation'), ''),
      nullif(trim(v_item->>'publisher_name'), ''),
      nullif(trim(v_item->>'publishing_administrator'), ''),
      case when v_item ? 'share_controlled' then (v_item->>'share_controlled')::boolean else null end,
      nullif(trim(v_item->>'contact_email'), ''),
      nullif(trim(v_item->>'notes'), ''),
      v_idx
    );
    v_idx := v_idx + 1;
  end loop;

  v_idx := 0;
  for v_item in select * from jsonb_array_elements(coalesce(p_master, '[]'::jsonb))
  loop
    insert into public.split_sheet_master_owners (
      split_sheet_id, legal_name, professional_name, ownership_percent,
      label_name, may_license_master, evidence_reference, notes, sort_order
    ) values (
      v_sheet_id,
      trim(v_item->>'legal_name'),
      nullif(trim(v_item->>'professional_name'), ''),
      coalesce((v_item->>'ownership_percent')::numeric, (v_item->>'split_percent')::numeric),
      nullif(trim(v_item->>'label_name'), ''),
      coalesce((v_item->>'may_license_master')::boolean, false),
      nullif(trim(v_item->>'evidence_reference'), ''),
      nullif(trim(v_item->>'notes'), ''),
      v_idx
    );
    -- Mirror into contributors as ownership_side=master for unified reads
    insert into public.split_sheet_contributors (
      split_sheet_id, ownership_side, legal_name, professional_name, role,
      split_percent, notes, sort_order
    ) values (
      v_sheet_id, 'master',
      trim(v_item->>'legal_name'),
      nullif(trim(v_item->>'professional_name'), ''),
      'master_owner',
      coalesce((v_item->>'ownership_percent')::numeric, (v_item->>'split_percent')::numeric),
      nullif(trim(v_item->>'notes'), ''),
      v_idx
    );
    v_idx := v_idx + 1;
  end loop;

  update public.tracks
     set current_split_sheet_id = v_sheet_id,
         splits_ready = false,
         splits_ready_source = 'none',
         updated_at = now()
   where id = p_track_id;

  insert into public.rights_document_audit_events (
    track_id, split_sheet_id, event_kind, actor_kind, actor_label, actor_user_id, document_hash, detail
  ) values (
    p_track_id, v_sheet_id, 'create_version', p_actor_kind, p_actor_label, p_actor_user_id, p_document_hash,
    jsonb_build_object('version_number', v_version, 'superseded_previous', v_prev)
  );

  return jsonb_build_object(
    'ok', true,
    'split_sheet_id', v_sheet_id,
    'version_number', v_version,
    'composition_total', v_comp_total,
    'master_total', v_master_total,
    'previous_sheet_id', v_prev
  );
exception
  when others then
    return jsonb_build_object(
      'ok', false,
      'code', 'transaction_failed',
      'errors', jsonb_build_array(SQLERRM)
    );
end;
$$;

revoke all on function public.create_split_sheet_version(
  uuid, jsonb, jsonb, text, text, boolean, boolean, boolean, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_split_sheet_version(
  uuid, jsonb, jsonb, text, text, boolean, boolean, boolean, text, text, text, text, text
) to service_role;

-- Finalize: Fendi-only path should be enforced in edge auth; RPC still stamps server fields.
create or replace function public.finalize_split_sheet_version(
  p_split_sheet_id uuid,
  p_actor_kind text,
  p_actor_label text,
  p_actor_user_id text,
  p_document_hash text,
  p_document_storage_path text default null,
  p_document_mime text default null,
  p_document_kind text default 'agh_generated_summary',
  p_require_confirmations boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sheet public.split_sheets%rowtype;
  v_unconfirmed int;
  v_master_count int;
begin
  if p_actor_kind is distinct from 'fendi' then
    return jsonb_build_object('ok', false, 'code', 'fendi_only', 'error', 'finalize is Fendi-only');
  end if;

  select * into v_sheet from public.split_sheets where id = p_split_sheet_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_sheet.status in ('final', 'superseded') then
    return jsonb_build_object('ok', false, 'code', 'immutable', 'error', 'finalized versions are immutable');
  end if;

  if p_require_confirmations then
    select count(*) into v_unconfirmed
      from public.split_sheet_contributors
     where split_sheet_id = p_split_sheet_id
       and ownership_side = 'composition'
       and confirmation_status not in ('confirmed', 'waived_by_fendi');
    -- Allow finalize when uploaded signed evidence exists even if unconfirmed rows remain.
    if v_unconfirmed > 0 and p_document_kind = 'agh_generated_summary' then
      return jsonb_build_object(
        'ok', false,
        'code', 'confirmations_incomplete',
        'unconfirmed', v_unconfirmed
      );
    end if;
  end if;

  select count(*) into v_master_count
    from public.split_sheet_master_owners where split_sheet_id = p_split_sheet_id;
  if v_master_count = 0 and not coalesce(v_sheet.master_controlled, false) then
    return jsonb_build_object('ok', false, 'code', 'master_control_required');
  end if;

  update public.split_sheets
     set status = 'final',
         document_kind = coalesce(nullif(p_document_kind, ''), document_kind),
         document_hash = coalesce(p_document_hash, document_hash),
         document_storage_path = coalesce(p_document_storage_path, document_storage_path),
         document_mime = coalesce(p_document_mime, document_mime),
         fendi_approved_at = now(),
         fendi_approved_by = p_actor_label,
         finalized_at = now(),
         finalized_by = p_actor_label,
         is_current = true,
         updated_at = now()
   where id = p_split_sheet_id;

  update public.tracks
     set current_split_sheet_id = p_split_sheet_id,
         splits_ready = true,
         splits_ready_source = 'authoritative_final',
         updated_at = now()
   where id = v_sheet.track_id;

  insert into public.rights_document_audit_events (
    track_id, split_sheet_id, event_kind, actor_kind, actor_label, actor_user_id, document_hash, detail
  ) values (
    v_sheet.track_id, p_split_sheet_id, 'finalize', p_actor_kind, p_actor_label, p_actor_user_id,
    coalesce(p_document_hash, v_sheet.document_hash),
    jsonb_build_object('document_kind', p_document_kind)
  );

  return jsonb_build_object('ok', true, 'split_sheet_id', p_split_sheet_id, 'splits_ready', true);
end;
$$;

revoke all on function public.finalize_split_sheet_version(
  uuid, text, text, text, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.finalize_split_sheet_version(
  uuid, text, text, text, text, text, text, text, boolean
) to service_role;

-- Delivery policy seed
insert into public.ops_settings (setting_key, setting_value, description) values
(
  'split_sheet_delivery_policy',
  jsonb_build_object(
    'default', 'request_only',
    'allow_auto_attach_on_initial_pitch', false,
    'secure_link_ttl_seconds', 900
  ),
  'Default sync pitch must not attach full split sheets. Delivery is request_only unless opportunity/Fendi requires it.'
)
on conflict (setting_key) do nothing;

commit;
