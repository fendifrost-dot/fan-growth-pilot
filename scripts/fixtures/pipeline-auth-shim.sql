-- Isolated test database only: the Supabase auth helpers that older migrations reference
-- in RLS policies (not present in the structural fixture).
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function public.has_role(uid uuid, role text) returns boolean language sql stable as $$ select false $$;
