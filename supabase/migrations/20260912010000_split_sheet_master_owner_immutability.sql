-- Amendment: immutability for master owners on finalized split sheets.
-- Apply via Lovable SQL Editor. Additive.

begin;

create or replace function public._split_sheet_master_owners_prevent_final_mutation()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from public.split_sheets
   where id = coalesce(new.split_sheet_id, old.split_sheet_id);
  if v_status = 'final' then
    raise exception 'cannot mutate master owners on a finalized split sheet — create a new version';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists split_sheet_master_owners_final_immutable
  on public.split_sheet_master_owners;
create trigger split_sheet_master_owners_final_immutable
  before insert or update or delete on public.split_sheet_master_owners
  for each row execute function public._split_sheet_master_owners_prevent_final_mutation();

comment on function public._split_sheet_master_owners_prevent_final_mutation() is
  'Finalized split sheets are immutable — master ownership corrections require a new version.';

commit;
