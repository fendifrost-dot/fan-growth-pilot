// Pitch Portal — explicit pitch campaigns.
//
// A track is pitchable ONLY if it has an 'active' row in pitch_campaigns.
// Nothing infers pitch scope from catalogue membership, smart links, or Song DNA
// alone; the artist (Fendi) creates/activates a campaign deliberately.
//
// Activation requires:
//   * Fendi authorization
//   * tracks.approved_song_dna_version_id + matching approved song_dna_versions row
//   * approved DNA short_pitch (never caller-written / tracks.short_pitch)
//   * approved / excluded lanes from that DNA
//   * a selected live smart link
//   * a server-generated configuration_snapshot
//
// Dispatched from control-center-api (manage_campaigns capability + Fendi gate).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import type { Actor } from './outreach-auth.ts';
import { resolveOpsActor, type OpsActor } from './ops-actors.ts';

export const PITCH_CAMPAIGN_ACTIONS = [
  'list_campaigns',
  'create_campaign',
  'update_campaign',
  'check_campaign_config',
  'list_campaignable_tracks',
] as const;

export function isPitchCampaignAction(action: string): boolean {
  return (PITCH_CAMPAIGN_ACTIONS as readonly string[]).includes(action);
}

type Result = { status: number; data: Record<string, unknown> };

const CAMPAIGN_STATUSES = ['active', 'paused', 'ended'] as const;
type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Start of the current day in America/Chicago, as an ISO instant. */
export function chicagoDayStartIso(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const elapsedMs = ((hour * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  return new Date(now.getTime() - elapsedMs).toISOString();
}

// ---------------------------------------------------------------------------
// Config guardrail — approved Song DNA + live smart link (not legacy fields)
// ---------------------------------------------------------------------------

export type CampaignConfig = {
  ready: boolean;
  missing: string[];
  track_id: string;
  track_name: string;
  has_smart_link: boolean;
  smart_link_id: string | null;
  smart_link_url: string | null;
  smart_link_slug: string | null;
  song_dna_version_id: string | null;
  has_approved_dna: boolean;
  has_dna_pitch_copy: boolean;
  approved_lanes: string[];
  excluded_lanes: string[];
  dna_short_pitch: string | null;
  /** @deprecated legacy surface — always 0; categories are not campaign auth */
  category_count: number;
  /** @deprecated legacy surface — mirrors has_dna_pitch_copy for older UI */
  has_pitch_copy: boolean;
};

const CALLER_PITCH_KEYS = [
  'pitch_copy',
  'short_pitch',
  'pitch_body',
  'body',
  'subject',
  'pitch_subject',
  'pitch_subject_template',
] as const;

/** Reject caller-written pitch copy on campaign create/activate/update. */
export function rejectCallerCampaignPitchCopy(
  body: Record<string, unknown>,
): Result | null {
  for (const key of CALLER_PITCH_KEYS) {
    if (body[key] !== undefined && body[key] !== null && String(body[key]).trim() !== '') {
      return {
        status: 422,
        data: {
          error: `Caller-written ${key} is not accepted. Campaign pitch copy comes only from approved Song DNA.`,
          code: 'caller_pitch_copy_rejected',
        },
      };
    }
  }
  return null;
}

/** Activation (status → active) is Fendi-session only. */
export function requireFendiCampaignActivation(ops: OpsActor): Result | null {
  if (ops.kind === 'fendi') return null;
  return {
    status: 403,
    data: {
      error: `${ops.label} is not permitted to activate pitch campaigns; Fendi authorization required`,
      code: 'fendi_activation_required',
    },
  };
}

/**
 * A campaign cannot go 'active' half-configured. Requires:
 *   1. a LIVE smart link bound to the campaign (is_active = true),
 *   2. tracks.approved_song_dna_version_id pointing at an approved DNA version
 *      for this track (not stale / missing / unapproved),
 *   3. non-empty short_pitch on that DNA version,
 *   4. lanes sourced from that DNA (informational; empty lanes still allowed
 *      when DNA is otherwise approved — missing DNA itself is the refusal).
 *
 * Does NOT authorize via tracks.short_pitch or track_categories.
 */
export async function evaluateCampaignConfig(
  sb: SupabaseClient,
  trackId: string,
  smartLinkId: string | null,
): Promise<CampaignConfig | null> {
  const { data: track } = await sb
    .from('tracks')
    .select('id, name, approved_song_dna_version_id')
    .eq('id', trackId)
    .maybeSingle();
  if (!track) return null;

  let hasSmartLink = false;
  let smartLinkUrl: string | null = null;
  let smartLinkSlug: string | null = null;
  if (smartLinkId) {
    const { data: link } = await sb
      .from('smart_links')
      .select('id, slug, is_active')
      .eq('id', smartLinkId)
      .maybeSingle();
    if (link && link.is_active) {
      hasSmartLink = true;
      smartLinkSlug = String(link.slug ?? '');
      smartLinkUrl = `https://links.fendifrost.com/${link.slug}`;
    }
  }

  const approvedId = track.approved_song_dna_version_id
    ? String(track.approved_song_dna_version_id)
    : null;

  let hasApprovedDna = false;
  let hasDnaPitchCopy = false;
  let dnaShortPitch: string | null = null;
  let approvedLanes: string[] = [];
  let excludedLanes: string[] = [];
  let boundDnaId: string | null = null;

  if (approvedId) {
    const { data: dna } = await sb
      .from('song_dna_versions')
      .select(
        'id, track_id, approval_state, short_pitch, approved_lanes, excluded_lanes',
      )
      .eq('id', approvedId)
      .maybeSingle();

    if (
      dna &&
      String(dna.track_id) === String(track.id) &&
      String(dna.approval_state) === 'approved'
    ) {
      hasApprovedDna = true;
      boundDnaId = String(dna.id);
      dnaShortPitch = dna.short_pitch == null ? null : String(dna.short_pitch);
      hasDnaPitchCopy = Boolean(dnaShortPitch && dnaShortPitch.trim().length > 0);
      approvedLanes = Array.isArray(dna.approved_lanes)
        ? dna.approved_lanes.map((l: unknown) => String(l))
        : [];
      excludedLanes = Array.isArray(dna.excluded_lanes)
        ? dna.excluded_lanes.map((l: unknown) => String(l))
        : [];
    }
  }

  const missing: string[] = [];
  if (!hasSmartLink) missing.push('smart_link');
  if (!hasApprovedDna) missing.push('approved_song_dna');
  if (hasApprovedDna && !hasDnaPitchCopy) missing.push('dna_short_pitch');

  return {
    ready: missing.length === 0,
    missing,
    track_id: String(track.id),
    track_name: String(track.name ?? ''),
    has_smart_link: hasSmartLink,
    smart_link_id: smartLinkId,
    smart_link_url: smartLinkUrl,
    smart_link_slug: smartLinkSlug,
    song_dna_version_id: boundDnaId,
    has_approved_dna: hasApprovedDna,
    has_dna_pitch_copy: hasDnaPitchCopy,
    approved_lanes: approvedLanes,
    excluded_lanes: excludedLanes,
    dna_short_pitch: dnaShortPitch,
    category_count: 0,
    has_pitch_copy: hasDnaPitchCopy,
  };
}

/** Server-owned snapshot frozen at activation. Never accepts caller pitch copy. */
export function buildCampaignConfigurationSnapshot(
  config: CampaignConfig,
): Record<string, unknown> {
  return {
    track_id: config.track_id,
    track_name: config.track_name,
    song_dna_version_id: config.song_dna_version_id,
    short_pitch: config.dna_short_pitch,
    approved_lanes: config.approved_lanes,
    excluded_lanes: config.excluded_lanes,
    smart_link_id: config.smart_link_id,
    smart_link_slug: config.smart_link_slug,
    smart_link_url: config.smart_link_url,
    snapshot_source: 'server_activation',
    snapshotted_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Guardrail used by the pitch/draft/send path
// ---------------------------------------------------------------------------

export async function activeCampaignTrackNames(sb: SupabaseClient): Promise<Set<string>> {
  const { data } = await sb
    .from('pitch_campaigns')
    .select('tracks(name)')
    .eq('status', 'active');
  const names = new Set<string>();
  for (const row of (data ?? []) as { tracks?: { name?: string } | null }[]) {
    const n = String(row.tracks?.name ?? '').trim().toLowerCase();
    if (n) names.add(n);
  }
  return names;
}

export async function assertTrackHasActiveCampaign(
  sb: SupabaseClient,
  opts: { trackId?: string | null; trackName?: string | null },
): Promise<void> {
  const trackId = String(opts.trackId ?? '').trim();
  if (trackId) {
    const { data } = await sb
      .from('pitch_campaigns')
      .select('id')
      .eq('track_id', trackId)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) {
      throw new Error(
        'No active pitch campaign for this track. Create one in the Pitch Portal before pitching it.',
      );
    }
    return;
  }

  const trackName = String(opts.trackName ?? '').trim().toLowerCase();
  if (!trackName) throw new Error('track_id or track_name required to check campaign status');
  const active = await activeCampaignTrackNames(sb);
  if (!active.has(trackName)) {
    throw new Error(
      `No active pitch campaign for "${opts.trackName}". Create one in the Pitch Portal before pitching it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

type CampaignStats = {
  sent: number;
  sent_today: number;
  replies: number;
  placements: number;
  targets_remaining: number;
  last_sent_at: string | null;
};

async function loadStats(
  sb: SupabaseClient,
  trackNames: string[],
): Promise<Map<string, CampaignStats>> {
  const wanted = new Set(trackNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const out = new Map<string, CampaignStats>();
  for (const n of wanted) {
    out.set(n, {
      sent: 0,
      sent_today: 0,
      replies: 0,
      placements: 0,
      targets_remaining: 0,
      last_sent_at: null,
    });
  }
  if (wanted.size === 0) return out;

  const dayStart = chicagoDayStartIso();
  const { data: logs } = await sb
    .from('pitch_log')
    .select('track_name, playlist_id, sent_at, reply_received, placed, placement_status');

  const pitchedByTrack = new Map<string, Set<string>>();
  for (const row of (logs ?? []) as Record<string, unknown>[]) {
    const key = String(row.track_name ?? '').trim().toLowerCase();
    const s = out.get(key);
    if (!s) continue;

    s.sent += 1;
    const sentAt = row.sent_at ? String(row.sent_at) : null;
    if (sentAt) {
      if (sentAt >= dayStart) s.sent_today += 1;
      if (!s.last_sent_at || sentAt > s.last_sent_at) s.last_sent_at = sentAt;
    }
    if (row.reply_received === true) s.replies += 1;
    if (row.placed === true || row.placement_status === 'placed') s.placements += 1;

    const pid = String(row.playlist_id ?? '');
    if (pid) {
      if (!pitchedByTrack.has(key)) pitchedByTrack.set(key, new Set());
      pitchedByTrack.get(key)!.add(pid);
    }
  }

  const { data: targets } = await sb
    .from('playlist_targets')
    .select('playlist_id, curator_email, is_active, fraud_verdict')
    .not('curator_email', 'is', null);

  const pool = ((targets ?? []) as Record<string, unknown>[]).filter(
    (t) =>
      t.is_active !== false &&
      t.fraud_verdict !== 'pay_to_play' &&
      String(t.curator_email ?? '').includes('@'),
  );

  for (const [key, stats] of out) {
    const pitched = pitchedByTrack.get(key) ?? new Set<string>();
    stats.targets_remaining = pool.filter((t) => !pitched.has(String(t.playlist_id ?? ''))).length;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type CampaignRow = Record<string, unknown> & {
  id: string;
  track_id: string;
  status: string;
  tracks?: { name?: string } | null;
  smart_links?: { slug?: string; is_active?: boolean } | null;
};

function actorUserId(actor: Actor | null): string | null {
  return actor?.kind === 'user' ? actor.userId : null;
}

async function listCampaigns(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const statusFilter = String(body.status ?? '').trim();

  if (statusFilter && statusFilter !== 'all' && !(CAMPAIGN_STATUSES as readonly string[]).includes(statusFilter)) {
    return { status: 400, data: { error: `status must be one of ${CAMPAIGN_STATUSES.join(', ')} or 'all'` } };
  }

  let filter = sb
    .from('pitch_campaigns')
    .select(
      'id, track_id, smart_link_id, song_dna_version_id, status, daily_target, notes, configuration_snapshot, started_at, activated_at, paused_at, ended_at, created_by, approved_by, created_at, updated_at, tracks(name), smart_links(slug, is_active)',
    );

  if (statusFilter && statusFilter !== 'all') {
    filter = filter.eq('status', statusFilter);
  }

  const { data, error } = await filter.order('created_at', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as CampaignRow[];
  const stats = await loadStats(sb, rows.map((r) => String(r.tracks?.name ?? '')));

  return {
    status: 200,
    data: {
      ok: true,
      rows: rows.map((r) => {
        const name = String(r.tracks?.name ?? '');
        const s = stats.get(name.trim().toLowerCase());
        return {
          ...r,
          track_name: name,
          smart_link_slug: r.smart_links?.slug ?? null,
          smart_link_active: r.smart_links?.is_active ?? false,
          stats: s ?? {
            sent: 0,
            sent_today: 0,
            replies: 0,
            placements: 0,
            targets_remaining: 0,
            last_sent_at: null,
          },
        };
      }),
    },
  };
}

async function listCampaignableTracks(sb: SupabaseClient): Promise<Result> {
  const { data: tracks, error } = await sb
    .from('tracks')
    .select('id, name, approved_song_dna_version_id, status')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  const { data: open } = await sb
    .from('pitch_campaigns')
    .select('id, track_id, status')
    .in('status', ['active', 'paused', 'draft']);
  const openByTrack = new Map<string, { id: string; status: string }>();
  for (const c of (open ?? []) as { id: string; track_id: string; status: string }[]) {
    openByTrack.set(c.track_id, { id: c.id, status: c.status });
  }

  const { data: links } = await sb
    .from('smart_links')
    .select('id, slug, title, is_active')
    .eq('is_active', true)
    .order('title');

  const dnaIds = [
    ...new Set(
      ((tracks ?? []) as Record<string, unknown>[])
        .map((t) => t.approved_song_dna_version_id)
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ];
  const dnaById = new Map<string, Record<string, unknown>>();
  if (dnaIds.length) {
    const { data: dnaRows } = await sb
      .from('song_dna_versions')
      .select('id, track_id, approval_state, short_pitch, approved_lanes, excluded_lanes')
      .in('id', dnaIds);
    for (const row of (dnaRows ?? []) as Record<string, unknown>[]) {
      dnaById.set(String(row.id), row);
    }
  }

  return {
    status: 200,
    data: {
      ok: true,
      rows: ((tracks ?? []) as Record<string, unknown>[]).map((t) => {
        const existing = openByTrack.get(String(t.id));
        const dnaId = t.approved_song_dna_version_id
          ? String(t.approved_song_dna_version_id)
          : null;
        const dna = dnaId ? dnaById.get(dnaId) : null;
        const dnaOk =
          !!dna &&
          String(dna.track_id) === String(t.id) &&
          String(dna.approval_state) === 'approved';
        const pitch = dnaOk && dna?.short_pitch != null
          ? String(dna.short_pitch).trim()
          : '';
        const lanes = dnaOk && Array.isArray(dna?.approved_lanes)
          ? (dna!.approved_lanes as unknown[]).length
          : 0;
        return {
          id: t.id,
          name: t.name,
          approved_song_dna_version_id: dnaOk ? dnaId : null,
          has_approved_dna: dnaOk,
          has_dna_pitch_copy: pitch.length > 0,
          approved_lane_count: lanes,
          // Legacy UI fields — DNA pitch, not tracks.short_pitch / categories
          has_pitch_copy: pitch.length > 0,
          category_count: lanes,
          open_campaign_id: existing?.id ?? null,
          open_campaign_status: existing?.status ?? null,
        };
      }),
      smart_links: links ?? [],
    },
  };
}

async function checkCampaignConfig(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const trackId = String(body.track_id ?? '').trim();
  if (!trackId) return { status: 400, data: { error: 'track_id required' } };
  const smartLinkId = body.smart_link_id ? String(body.smart_link_id) : null;

  const config = await evaluateCampaignConfig(sb, trackId, smartLinkId);
  if (!config) return { status: 404, data: { error: 'Track not found' } };
  return { status: 200, data: { ok: true, config } };
}

async function createCampaign(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  ops: OpsActor,
): Promise<Result> {
  const pitchReject = rejectCallerCampaignPitchCopy(body);
  if (pitchReject) return pitchReject;

  const trackId = String(body.track_id ?? '').trim();
  if (!trackId) return { status: 400, data: { error: 'track_id required' } };

  const smartLinkId = body.smart_link_id ? String(body.smart_link_id) : null;
  const dailyTarget = Math.min(200, Math.max(1, Number(body.daily_target) || 20));
  const notes = body.notes == null ? null : String(body.notes);
  const wantActive = body.status == null ? true : String(body.status) === 'active';

  if (wantActive) {
    const fendiGate = requireFendiCampaignActivation(ops);
    if (fendiGate) return fendiGate;
  }

  const { data: existing } = await sb
    .from('pitch_campaigns')
    .select('id, status')
    .eq('track_id', trackId)
    .in('status', ['active', 'paused', 'draft'])
    .maybeSingle();
  if (existing) {
    return {
      status: 409,
      data: {
        error: `This track already has a ${existing.status} campaign. Resume or end it instead of creating a second one.`,
        campaign_id: existing.id,
      },
    };
  }

  const config = await evaluateCampaignConfig(sb, trackId, smartLinkId);
  if (!config) return { status: 404, data: { error: 'Track not found' } };
  if (wantActive && !config.ready) {
    return {
      status: 400,
      data: {
        error: 'Campaign is not fully configured',
        missing: config.missing,
        config,
      },
    };
  }

  const status: CampaignStatus = wantActive ? 'active' : 'paused';
  const nowIso = new Date().toISOString();
  const snapshot = wantActive ? buildCampaignConfigurationSnapshot(config) : {};
  const insert: Record<string, unknown> = {
    track_id: trackId,
    smart_link_id: smartLinkId,
    song_dna_version_id: wantActive ? config.song_dna_version_id : null,
    status,
    daily_target: dailyTarget,
    notes,
    configuration_snapshot: snapshot,
    started_at: status === 'active' ? nowIso : null,
    activated_at: status === 'active' ? nowIso : null,
    created_by: actorUserId(actor),
    approved_by: status === 'active' ? actorUserId(actor) : null,
  };

  const { data, error } = await sb
    .from('pitch_campaigns')
    .insert(insert)
    .select('*')
    .single();
  if (error) throw error;

  return { status: 200, data: { ok: true, campaign: data, config } };
}

async function updateCampaign(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  ops: OpsActor,
): Promise<Result> {
  const pitchReject = rejectCallerCampaignPitchCopy(body);
  if (pitchReject) return pitchReject;

  const campaignId = String(body.campaign_id ?? '').trim();
  if (!campaignId) return { status: 400, data: { error: 'campaign_id required' } };

  const { data: current } = await sb
    .from('pitch_campaigns')
    .select('id, track_id, smart_link_id, status, started_at, activated_at')
    .eq('id', campaignId)
    .maybeSingle();
  if (!current) return { status: 404, data: { error: 'Campaign not found' } };

  const patch: Record<string, unknown> = {};

  if (body.daily_target != null) {
    patch.daily_target = Math.min(200, Math.max(1, Number(body.daily_target) || 20));
  }
  if (body.notes !== undefined) patch.notes = body.notes == null ? null : String(body.notes);
  if (body.smart_link_id !== undefined) {
    patch.smart_link_id = body.smart_link_id ? String(body.smart_link_id) : null;
  }

  const nextStatus = body.status == null ? null : String(body.status);
  if (nextStatus) {
    if (!(CAMPAIGN_STATUSES as readonly string[]).includes(nextStatus)) {
      return { status: 400, data: { error: `status must be one of ${CAMPAIGN_STATUSES.join(', ')}` } };
    }
    if (current.status === 'ended' && nextStatus !== 'ended') {
      return {
        status: 400,
        data: { error: 'This campaign has ended. Create a new campaign for this track instead of reopening it.' },
      };
    }

    if (nextStatus === 'active') {
      const fendiGate = requireFendiCampaignActivation(ops);
      if (fendiGate) return fendiGate;

      const smartLinkId =
        patch.smart_link_id !== undefined
          ? (patch.smart_link_id as string | null)
          : (current.smart_link_id as string | null);
      const config = await evaluateCampaignConfig(sb, String(current.track_id), smartLinkId);
      if (!config) return { status: 404, data: { error: 'Track not found' } };
      if (!config.ready) {
        return {
          status: 400,
          data: { error: 'Campaign is not fully configured', missing: config.missing, config },
        };
      }
      const nowIso = new Date().toISOString();
      if (!current.started_at) patch.started_at = nowIso;
      if (!current.activated_at) patch.activated_at = nowIso;
      patch.ended_at = null;
      patch.paused_at = null;
      patch.song_dna_version_id = config.song_dna_version_id;
      patch.configuration_snapshot = buildCampaignConfigurationSnapshot(config);
      patch.approved_by = actorUserId(actor);
    }

    if (nextStatus === 'paused') {
      patch.paused_at = new Date().toISOString();
    }
    if (nextStatus === 'ended') patch.ended_at = new Date().toISOString();
    patch.status = nextStatus;
  }

  if (Object.keys(patch).length === 0) {
    return { status: 400, data: { error: 'Nothing to update' } };
  }

  const { data, error } = await sb
    .from('pitch_campaigns')
    .update(patch)
    .eq('id', campaignId)
    .select('*')
    .single();
  if (error) throw error;

  return { status: 200, data: { ok: true, campaign: data } };
}

export async function runPitchCampaignAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null = null,
  req: Request | null = null,
): Promise<Result> {
  const ops = resolveOpsActor(actor, req);
  switch (action) {
    case 'list_campaigns':
      return await listCampaigns(sb, body);
    case 'list_campaignable_tracks':
      return await listCampaignableTracks(sb);
    case 'check_campaign_config':
      return await checkCampaignConfig(sb, body);
    case 'create_campaign':
      return await createCampaign(sb, body, actor, ops);
    case 'update_campaign':
      return await updateCampaign(sb, body, actor, ops);
    default:
      return { status: 400, data: { error: `Unknown pitch campaign action: ${action}` } };
  }
}
