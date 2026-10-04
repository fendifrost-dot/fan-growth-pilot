-- Outreach templates were seeded with markdown emphasis. Curator email is
-- plain text, so those asterisks were going out literally. Rendering also
-- strips emphasis; this updates rows already stored. Idempotent: a second
-- run finds no emphasis markers left around placeholders.
begin;

do $$
begin
  if to_regclass('public.pitch_templates') is null then
    return;
  end if;
  update public.pitch_templates
     set body_template = replace(replace(replace(body_template, '**', ''), '*{{', '{{'), '}}*', '}}'),
         updated_at = now()
   where body_template like '%**%'
      or body_template like '%*{{%'
      or body_template like '%}}*%';
end $$;

commit;
