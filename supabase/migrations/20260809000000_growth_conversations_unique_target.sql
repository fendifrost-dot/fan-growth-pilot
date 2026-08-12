-- Concurrency-hardening for growth_conversations find-or-create.
--
-- The find-or-create path (supabase/functions/_shared/opportunities/repository.ts)
-- is select-then-insert. growth_conversations (migration 20260801000000 §8.5b) has
-- entity/opportunity INDEXES but no UNIQUENESS, so two parallel Cowork agents can
-- both miss the select and both insert — producing duplicate business threads for
-- the same target. These partial unique indexes make the (entity, opportunity)
-- pair unique so the loser of a race hits 23505; the repository catches it and
-- returns the winning row (truly idempotent under parallelism).
--
-- Two shapes are supported, matching the repository's find-or-create keys:
--   * opportunity-scoped: at most one conversation per (entity_id, opportunity_id)
--   * opportunity-less:    at most one conversation per entity_id
-- Partial indexes keep them independent and let NULL opportunity_id behave as an
-- IS NULL match rather than the SQL "every NULL is distinct" default.
--
-- DEPLOY PREFLIGHT — run these BEFORE applying (each must return ZERO rows). If a
-- row comes back, a pre-existing duplicate exists and MUST be reconciled by hand
-- first, so the dup is found deliberately rather than via a failed CREATE INDEX:
--
--   -- opportunity-scoped duplicates:
--   select entity_id, opportunity_id, count(*)
--   from public.growth_conversations
--   where opportunity_id is not null
--   group by entity_id, opportunity_id
--   having count(*) > 1;
--
--   -- opportunity-less duplicates:
--   select entity_id, count(*)
--   from public.growth_conversations
--   where opportunity_id is null
--   group by entity_id
--   having count(*) > 1;

create unique index if not exists growth_conversations_entity_opp_uidx
  on public.growth_conversations (entity_id, opportunity_id)
  where opportunity_id is not null;

create unique index if not exists growth_conversations_entity_noopp_uidx
  on public.growth_conversations (entity_id)
  where opportunity_id is null;
