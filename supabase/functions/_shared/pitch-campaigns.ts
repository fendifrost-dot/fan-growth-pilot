// Pitch Portal — explicit pitch campaigns.
//
// A track is pitchable ONLY if it has an 'active' row in pitch_campaigns.
// Nothing infers pitch scope from catalogue membership or from the existence of
// a smart link any more; the artist creates a campaign deliberately.
//
// This module owns the campaign CRUD actions plus the guardrail that the pitch
// flow calls (see activeCampaignTrackNames / assertTrackHasActiveCampaign).
// It is dispatched from control-center-api as its own tier.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

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

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended'] as const;
type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Start of the current day in America/Chicago, as an ISO instant.
 *  Matches the CT send window the daily pitch job runs in, so "today's count"
 *  in the portal lines up with what the job actually sent today. */
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
  // Intl renders midnight as "24" in some runtimes.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const elapsedMs = ((hour * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  return new Date(now.getTime() - elapsedMs).toISOString();
}

// ---------------------------------------------------------------------------
// Config guardrail
// ---------------------------------------------------------------------------

export type CampaignConfig = {
  ready: boolean;
  missing: string[];
  track_id: string;
  track_name: string;
  has_smart_link: boolean;
  smart_link_id: string | null;
  smart_link_url: string | null;
  category_count: number;
  has_pitch_copy: boolean;
};

/**
 * A campaign cannot go 'active' half-configured. Requires:
 *   1. a LIVE smart link bound to the campaign (is_active = true),
 *   2. at least one assigned category/genre (track_categories),
 *   3. authored short_pitch copy on the track.
 *
 * Without (3) the pitch flow would fabricate copy; without (1) the email has no
 * stream link; without (2) target recommendation has nothing to match on.
 * The portal surfaces `missing` so the artist fills the gap rather than the
 * system silently pitching something wrong.
 */
export async function evaluateCampaignConfig(
  sb: SupabaseClient,
  trackId: string,
  smartLinkId: string | null,
): Promise<CampaignConfig | null> {
  const { data: track } = await sb
    .from('tracks')
    .select('id, name, short_pitch, track_categories(category_id)')
    .eq('id', trackId)
    .maybeSingle();
  if (!track) return null;

  let hasSmartLink = false;
  let smartLinkUrl: string | null = null;
  if (smartLinkId) {
    const { data: link } = await sb
      .from('smart_links')
      .select('id, slug, is_active')
      .eq('id', smartLinkId)
      .maybeSingle();
    if (link && link.is_active) {
      hasSmartLink = true;
      smartLinkUrl = `https://links.fendifrost.com/${link.slug}`;
    }
  }

  const categoryCount = ((track.track_categories ?? []) as unknown[]).length;
  const hasPitchCopy = String(track.short_pitch ?? '').trim().length > 0;

  const missing: string[] = [];
  if (!hasSmartLink) missing.push('smart_link');
  if (categoryCount === 0) missing.push('category');
  if (!hasPitchCopy) missing.push('short_pitch');

  return {
    ready: missing.length === 0,
    missing,
    track_id: String(track.id),
    track_name: String(track.name ?? ''),
    has_smart_link: hasSmartLink,
    smart_link_id: smartLinkId,
    smart_link_url: smartLinkUrl,
    category_count: categoryCount,
    has_pitch_copy: hasPitchCopy,
  };
}

// ---------------------------------------------------------------------------
// Guardrail used by the pitch/draft/send path
// ---------------------------------------------------------------------------

/** Lowercased names of every track with an ACTIVE campaign.
 *  pitch_log and playlist_targets key off track_name (text), not track_id, so
 *  callers that only know a name compare against this set. */
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

/** Throws unless the given track_id has an active campaign.
 *  Prefer exact track_id. Title fallback is legacy-only and must not be used for new sends. */
export async function assertTrackHasActiveCampaign(
  sb: SupabaseClient,
  opts: { trackId?: string | null; trackName?: string | null },
): Promise<{ campaign_id: string }> {
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
        'No active pitch campaign for this track_id. Create a draft and activate with approved Song DNA + Fendi approval before pitching.',
      );
    }
    return { campaign_id: String(data.id) };
  }

  throw new Error('track_id is required to check campaign status (title matching is not allowed for sends).');
}

/**
 * New sends require exact campaign_id + track_id, and the campaign must be
 * active for that track with live (non-legacy) authority.
 */
export async function assertSendCampaignIdentity(
  sb: SupabaseClient,
  opts: { trackId: string; campaignId: string },
): Promise<{ campaign: Record<string, unknown> }> {
  const trackId = String(opts.trackId ?? '').trim();
  const campaignId = String(opts.campaignId ?? '').trim();
  if (!trackId) throw new Error('track_id is required on every send');
  if (!campaignId) throw new Error('campaign_id is required on every send');

  const { data, error } = await sb
    .from('pitch_campaigns')
    .select('id, track_id, status, authority_kind, song_dna_version_id, fendi_activation_approved_at, configuration_snapshot')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Campaign lookup failed (${error.message}). pitch_campaigns must exist before sends.`,
    );
  }
  if (!data) throw new Error('campaign_id not found');
  if (String(data.track_id) !== trackId) {
    throw new Error('campaign_id does not belong to the supplied track_id');
  }
  if (data.status !== 'active') {
    throw new Error(`Campaign is ${data.status}, not active. Sends require an active campaign.`);
  }
  if (String(data.authority_kind ?? '') === 'legacy_reconstructed') {
    throw new Error('Legacy/reconstructed campaigns cannot authorize new sends.');
  }
  if (!data.song_dna_version_id || !data.fendi_activation_approved_at) {
    throw new Error('Campaign activation evidence incomplete (Song DNA + Fendi approval required).');
  }
  return { campaign: data as Record<string, unknown> };
}

/**
 * Verify an approved Song DNA version exists for the track.
 * Until Phase 1 creates song_dna_versions, activation remains disabled.
 */
export async function verifyApprovedSongDna(
  sb: SupabaseClient,
  opts: { trackId: string; songDnaVersionId: string },
): Promise<{ ok: true; version: Record<string, unknown> } | { ok: false; error: string }> {
  const trackId = String(opts.trackId ?? '').trim();
  const dnaId = String(opts.songDnaVersionId ?? '').trim();
  if (!trackId || !dnaId) {
    return { ok: false, error: 'track_id and song_dna_version_id are required' };
  }

  const { data, error } = await sb
    .from('song_dna_versions')
    .select('id, track_id, approval_state, version_number, primary_genre, approved_lanes, excluded_lanes')
    .eq('id', dnaId)
    .maybeSingle();

  if (error) {
    // Table missing or RLS — activation disabled until Phase 1 DNA exists.
    return {
      ok: false,
      error:
        'Campaign activation is disabled until approved Song DNA exists and can be verified ' +
        `(song_dna_versions unavailable: ${error.message}).`,
    };
  }
  if (!data) {
    return { ok: false, error: 'song_dna_version_id not found' };
  }
  if (String(data.track_id) !== trackId) {
    return { ok: false, error: 'Song DNA version does not belong to this track_id' };
  }
  if (String(data.approval_state) !== 'approved') {
    return {
      ok: false,
      error: `Song DNA version is '${data.approval_state}', not approved. Activation requires an approved version.`,
    };
  }
  return { ok: true, version: data as Record<string, unknown> };
}

export function buildActivationSnapshot(opts: {
  track: Record<string, unknown>;
  smartLink: Record<string, unknown> | null;
  dna: Record<string, unknown>;
  fendiApprovedBy: string;
  fendiApprovedAt: string;
  pitchCopy: string;
}): Record<string, unknown> {
  return {
    authority_kind: 'live',
    captured_at: opts.fendiApprovedAt,
    fendi_activation_approved_by: opts.fendiApprovedBy,
    fendi_activation_approved_at: opts.fendiApprovedAt,
    track_id: opts.track.id,
    track_name: opts.track.name,
    pitch_copy: opts.pitchCopy,
    smart_link_id: opts.smartLink?.id ?? null,
    smart_link_slug: opts.smartLink?.slug ?? null,
    song_dna_version_id: opts.dna.id,
    song_dna_version_number: opts.dna.version_number ?? null,
    primary_genre: opts.dna.primary_genre ?? null,
    approved_lanes: opts.dna.approved_lanes ?? null,
    excluded_lanes: opts.dna.excluded_lanes ?? null,
    note: 'Frozen at Fendi activation — not a reconstructed legacy snapshot.',
  };
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

/** Per-track pitch stats, computed in one pass over pitch_log.
 *  Joins on lower(track_name) because the outreach tables predate track_id. */
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

  // "Targets remaining" = emailable, active, not-yet-pitched-for-THIS-track
  // playlist targets. Deliberately a coarse pool count, not the full
  // recommend_targets_for_track ranking — the portal wants a runway number.
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
  tracks?: { name?: string; short_pitch?: string | null } | null;
  smart_links?: { slug?: string; is_active?: boolean } | null;
};

async function listCampaigns(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const statusFilter = String(body.status ?? '').trim();

  if (statusFilter && statusFilter !== 'all' && !(CAMPAIGN_STATUSES as readonly string[]).includes(statusFilter)) {
    return { status: 400, data: { error: `status must be one of ${CAMPAIGN_STATUSES.join(', ')} or 'all'` } };
  }

  // Filter before order: .order() returns a transform builder with no .eq().
  let filter = sb
    .from('pitch_campaigns')
    .select(
      'id, track_id, smart_link_id, status, daily_target, notes, started_at, ended_at, created_at, updated_at, tracks(name, short_pitch), smart_links(slug, is_active)',
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

/** Catalogue tracks with their config readiness + whether a campaign already
 *  exists, so the "Create a campaign" picker can show what needs filling in. */
async function listCampaignableTracks(sb: SupabaseClient): Promise<Result> {
  const { data: tracks, error } = await sb
    .from('tracks')
    .select('id, name, short_pitch, status, track_categories(category_id)')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  const { data: open } = await sb
    .from('pitch_campaigns')
    .select('id, track_id, status')
    .in('status', ['active', 'paused']);
  const openByTrack = new Map<string, { id: string; status: string }>();
  for (const c of (open ?? []) as { id: string; track_id: string; status: string }[]) {
    openByTrack.set(c.track_id, { id: c.id, status: c.status });
  }

  const { data: links } = await sb
    .from('smart_links')
    .select('id, slug, title, is_active')
    .eq('is_active', true)
    .order('title');

  return {
    status: 200,
    data: {
      ok: true,
      rows: ((tracks ?? []) as Record<string, unknown>[]).map((t) => {
        const existing = openByTrack.get(String(t.id));
        return {
          id: t.id,
          name: t.name,
          has_pitch_copy: String(t.short_pitch ?? '').trim().length > 0,
          category_count: ((t.track_categories ?? []) as unknown[]).length,
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

async function createCampaign(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const trackId = String(body.track_id ?? '').trim();
  if (!trackId) return { status: 400, data: { error: 'track_id required' } };

  const smartLinkId = body.smart_link_id ? String(body.smart_link_id) : null;
  const dailyTarget = Math.min(200, Math.max(1, Number(body.daily_target) || 20));
  const notes = body.notes == null ? null : String(body.notes);

  // Phase 0 locked decision §8: campaigns ALWAYS begin as drafts. Activation is a
  // separate Fendi-approved step (requires approved Song DNA + explicit approval).
  if (body.status != null && String(body.status) === 'active') {
    return {
      status: 400,
      data: {
        error:
          'Campaigns cannot be created as active. Create a draft, then activate with approved Song DNA and explicit Fendi approval.',
      },
    };
  }
  const requested = body.status == null ? 'draft' : String(body.status);
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(requested) || requested === 'active') {
    // 'active' already rejected; allow draft | paused | ended on create only if not active.
  }
  const status: CampaignStatus =
    requested === 'paused' || requested === 'ended' || requested === 'draft'
      ? (requested as CampaignStatus)
      : 'draft';

  const { data: existing } = await sb
    .from('pitch_campaigns')
    .select('id, status')
    .eq('track_id', trackId)
    .in('status', ['draft', 'active', 'paused'])
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

  const { data, error } = await sb
    .from('pitch_campaigns')
    .insert({
      track_id: trackId,
      smart_link_id: smartLinkId,
      status,
      daily_target: dailyTarget,
      notes,
      started_at: null,
      activated_at: null,
    })
    .select('*')
    .single();
  if (error) throw error;

  return { status: 200, data: { ok: true, campaign: data, config } };
}

async function updateCampaign(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const campaignId = String(body.campaign_id ?? '').trim();
  if (!campaignId) return { status: 400, data: { error: 'campaign_id required' } };

  const { data: current } = await sb
    .from('pitch_campaigns')
    .select('id, track_id, smart_link_id, status, started_at, pitch_copy, song_dna_version_id, fendi_activation_approved_by, fendi_activation_approved_at, authority_kind')
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

    // Activation requires verified approved Song DNA + explicit Fendi approval (§8).
    // Disabled until song_dna_versions exists and the version can be verified.
    if (nextStatus === 'active') {
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

      const dnaId =
        body.song_dna_version_id != null
          ? String(body.song_dna_version_id).trim()
          : String(current.song_dna_version_id ?? '').trim();
      if (!dnaId) {
        return {
          status: 400,
          data: {
            error:
              'Activation requires an approved Song DNA version id. Campaign activation is disabled until approved Song DNA exists and can be verified.',
            missing: ['song_dna_version_id', 'fendi_activation_approval'],
          },
        };
      }

      const dnaCheck = await verifyApprovedSongDna(sb, {
        trackId: String(current.track_id),
        songDnaVersionId: dnaId,
      });
      if (!dnaCheck.ok) {
        return {
          status: 400,
          data: { error: dnaCheck.error, missing: ['approved_song_dna'] },
        };
      }

      const fendiBy = String(body.fendi_activation_approved_by ?? current.fendi_activation_approved_by ?? '').trim();
      if (!fendiBy) {
        return {
          status: 400,
          data: {
            error: 'Activation requires explicit Fendi approval (fendi_activation_approved_by).',
            missing: ['fendi_activation_approved_by'],
          },
        };
      }

      const { data: trackRow } = await sb
        .from('tracks')
        .select('id, name, short_pitch')
        .eq('id', current.track_id)
        .maybeSingle();
      if (!trackRow) return { status: 404, data: { error: 'Track not found' } };

      let smartLink: Record<string, unknown> | null = null;
      if (smartLinkId) {
        const { data: link } = await sb
          .from('smart_links')
          .select('id, slug, is_active')
          .eq('id', smartLinkId)
          .maybeSingle();
        smartLink = (link as Record<string, unknown> | null) ?? null;
      }

      const pitchCopy = String(
        body.pitch_copy ?? current.pitch_copy ?? trackRow.short_pitch ?? '',
      ).trim();
      if (!pitchCopy) {
        return { status: 400, data: { error: 'pitch_copy required at activation', missing: ['pitch_copy'] } };
      }

      const nowIso = new Date().toISOString();
      const snapshot = buildActivationSnapshot({
        track: trackRow as Record<string, unknown>,
        smartLink,
        dna: dnaCheck.version,
        fendiApprovedBy: fendiBy,
        fendiApprovedAt: String(body.fendi_activation_approved_at ?? '').trim() || nowIso,
        pitchCopy,
      });

      patch.song_dna_version_id = dnaId;
      patch.fendi_activation_approved_by = fendiBy;
      patch.fendi_activation_approved_at = snapshot.fendi_activation_approved_at;
      patch.authority_kind = 'live';
      patch.activated_at = nowIso;
      patch.pitch_copy = pitchCopy;
      patch.configuration_snapshot = snapshot;
      if (!current.started_at) patch.started_at = nowIso;
      patch.ended_at = null;
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
): Promise<Result> {
  switch (action) {
    case 'list_campaigns':
      return await listCampaigns(sb, body);
    case 'list_campaignable_tracks':
      return await listCampaignableTracks(sb);
    case 'check_campaign_config':
      return await checkCampaignConfig(sb, body);
    case 'create_campaign':
      return await createCampaign(sb, body);
    case 'update_campaign':
      return await updateCampaign(sb, body);
    default:
      return { status: 400, data: { error: `Unknown pitch campaign action: ${action}` } };
  }
}
