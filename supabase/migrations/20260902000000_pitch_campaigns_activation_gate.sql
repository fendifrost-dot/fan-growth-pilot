-- Pitch campaigns — Fendi activation gate (supersedes auto-seed in 20260718010000 §10).
--
-- LOCKED DECISION (docs/PHASE0_LOCKED_DECISIONS.md §8):
--   * Campaigns begin as drafts.
--   * No campaign is automatically activated.
--   * Activation requires approved Song DNA + explicit Fendi approval.
--   * New sends require a campaign ID (enforced in send path once campaigns are live).
--   * Historical / reconstructed records are labeled legacy — never treated as
--     approved activation snapshots.
--
-- DO NOT APPLY the seed block in 20260718010000_pitch_campaigns_phase1.sql
-- (auto-activates Meditate + DFM with daily_target 20 and a reconstructed snapshot).
-- That section is revised in-repo to create draft/legacy rows only; this migration
-- is the forward gate for live DBs and clean replays.
--
-- Idempotent. Safe if pitch_campaigns does not yet exist (no-op on missing table).
-- Does NOT invent Song DNA rows — song_dna_version_id stays NULL until Phase 1.

begin;

-- ---------------------------------------------------------------------------
-- 1. Activation / authority columns (only if base table exists)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.pitch_campaigns') is null then
    raise notice 'pitch_campaigns not present — skip activation-gate alters (apply July campaign migrations first, without the auto-active seed)';
    return;
  end if;

  alter table public.pitch_campaigns
    add column if not exists authority_kind text not null default 'live';

  alter table public.pitch_campaigns
    drop constraint if exists pitch_campaigns_authority_kind_chk;
  alter table public.pitch_campaigns
    add constraint pitch_campaigns_authority_kind_chk
    check (authority_kind in ('live', 'legacy_reconstructed'));

  alter table public.pitch_campaigns
    add column if not exists song_dna_version_id uuid;
  -- FK to song_dna_versions added in Phase 1 once that table exists.

  alter table public.pitch_campaigns
    add column if not exists fendi_activation_approved_by text,
    add column if not exists fendi_activation_approved_at timestamptz;

  comment on column public.pitch_campaigns.authority_kind is
    'live = activated under current Fendi gate; legacy_reconstructed = historical backfill, not an approved snapshot.';
  comment on column public.pitch_campaigns.song_dna_version_id is
    'Approved Song DNA version required before activation (Phase 1). NULL until DNA exists.';
  comment on column public.pitch_campaigns.fendi_activation_approved_by is
    'Fendi approver identity for activation. Required for status=active under the service gate.';
  comment on column public.pitch_campaigns.fendi_activation_approved_at is
    'When Fendi explicitly approved activation. Never inferred from seeding.';

  -- Ensure draft default (overrides any earlier default 'active').
  alter table public.pitch_campaigns alter column status set default 'draft';

  -- Demote any auto-seeded active campaigns from the superseded §10 seed.
  update public.pitch_campaigns
  set status = 'draft',
      authority_kind = 'legacy_reconstructed',
      activated_at = null,
      notes = coalesce(notes || ' ', '') ||
              '[Phase0] Demoted from auto-seeded active; awaiting Fendi activation + approved Song DNA.',
      configuration_snapshot = coalesce(configuration_snapshot, '{}'::jsonb) ||
        jsonb_build_object(
          'authority_kind', 'legacy_reconstructed',
          'demoted_by', '20260902000000_pitch_campaigns_activation_gate',
          'note', 'Reconstructed / auto-seeded — not an approved Fendi activation snapshot.'
        )
  where status = 'active'
    and (
      coalesce(configuration_snapshot->>'seeded_by', '') = '20260718010000_pitch_campaigns_phase1'
      or coalesce(notes, '') ilike '%Seed campaign backfilled%'
      or fendi_activation_approved_at is null
    );
end$$;

commit;
