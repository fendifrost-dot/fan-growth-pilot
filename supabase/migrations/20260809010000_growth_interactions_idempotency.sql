-- Proposal-stage idempotency for growth_interactions.
--
-- Week-1 proposed touches have no provider message id yet, so the existing
-- unique(interaction_type, external_message_id) (migration 20260801000000 §8.5c)
-- cannot dedupe a retry / timeout / parallel Cowork agent. The Cowork operation
-- supplies an explicit idempotency_key, stored in payload.idempotency_key on the
-- EXISTING jsonb column (no new column). This partial UNIQUE expression index
-- makes that key unique, so a duplicate submit collides (23505) and the
-- repository returns the existing interaction. We deliberately do NOT overload
-- external_message_id with a fake value.
--
-- Pre-existing rows have no payload.idempotency_key, so the partial predicate
-- excludes them and this index cannot conflict with historical data. (A preflight
-- is therefore unnecessary here — unlike the growth_conversations migration.)

create unique index if not exists growth_interactions_idempotency_uidx
  on public.growth_interactions ((payload->>'idempotency_key'))
  where payload ? 'idempotency_key';
