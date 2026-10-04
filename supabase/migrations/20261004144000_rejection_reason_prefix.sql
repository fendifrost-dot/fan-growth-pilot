-- Reject reasons were stored as concat_ws(reason codes, reason). When the
-- reason already started with the code, the prefix was written twice
-- ("LOW_REACH: LOW_REACH: ..."). Keep a single prefix. Do not rewrite rows
-- that are already stored.
begin;

create or replace function public.agh_compose_rejection_reason(p_codes jsonb, p_reason text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  codes text;
  reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select nullif(string_agg(value, ', '), '') into codes
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_codes) = 'array' then p_codes else '[]'::jsonb end
  );
  if reason is null then
    return codes;
  end if;
  if codes is null then
    return reason;
  end if;
  if lower(reason) = lower(codes)
     or lower(left(reason, length(codes) + 1)) = lower(codes) || ':'
     or lower(left(reason, length(codes) + 1)) = lower(codes) || ' ' then
    return reason;
  end if;
  return codes || ': ' || reason;
end;
$$;

revoke all on function public.agh_compose_rejection_reason(jsonb, text) from public, anon, authenticated;
grant execute on function public.agh_compose_rejection_reason(jsonb, text) to service_role;

commit;
