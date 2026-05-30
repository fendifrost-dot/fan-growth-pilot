import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isPlaylistAgentAction, runPlaylistAgentAction } from '../_shared/playlist-agent-run.ts';
import { isRadioAction, runRadioAction } from '../_shared/radio-outreach.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
};

const PLATFORM_STAT_IDENTIFIERS = [
  'spotify_artist_stats',
  'instagram_stats',
  'facebook_stats',
  'x_stats',
  'shazam_stats',
  'chartmetric_overview',
  'youtube_channel_stats',
  'youtube_chartmetric_stats',
  'soundcloud_user_stats',
  'tiktok_stats',
  'pandora_stats',
];

type AuthResult =
  | { ok: true; via: 'hub_key' }
  | { ok: true; via: 'browser' };

function authenticate(req: Request): AuthResult {
  const hubKey = (Deno.env.get('FANFUEL_HUB_KEY') || '').trim();
  const xApiKey = (req.headers.get('x-api-key') || '').trim();
  if (hubKey && xApiKey && xApiKey === hubKey) {
    return { ok: true, via: 'hub_key' };
  }
  return { ok: true, via: 'browser' };
}

async function resolveArtistUserId(supabase: ReturnType<typeof createClient>): Promise<string> {
  const envId = (Deno.env.get('ARTIST_USER_ID') || '').trim();
  if (envId) return envId;

  const { data: profile, error } = await supabase.from('profiles').select('id').limit(1).single();
  if (error || !profile) throw new Error('No profile found');
  return profile.id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const expectedKey = (Deno.env.get('FANFUEL_HUB_KEY') || '').trim();
    const authResult = authenticate(req);
    console.log('control-center-api auth via:', authResult.via);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    if (isPlaylistAgentAction(String(action ?? ''))) {
      const result = await runPlaylistAgentAction(String(action), body, supabase, expectedKey);
      return new Response(JSON.stringify(result.data), {
        status: result.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (isRadioAction(String(action ?? ''))) {
      const result = await runRadioAction(String(action), body, supabase, expectedKey);
      return new Response(JSON.stringify(result.data), {
        status: result.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    switch (action) {
      case 'get_fan_stats':
        return jsonResponse(await getFanStats(supabase), corsHeaders);

      case 'get_leads':
        return jsonResponse(await getLeads(supabase), corsHeaders);

      case 'get_momentum_alerts':
        return jsonResponse(await getMomentumAlerts(supabase), corsHeaders);

      case 'get_marketing_actions':
        return jsonResponse(await getMarketingActions(supabase), corsHeaders);

      case 'get_platform_metrics':
        return jsonResponse(await getPlatformMetrics(supabase), corsHeaders);

      // --- Apple Music radio/DJ growth ---
      case 'ingest_apple_spins':
        if (authResult.via !== 'hub_key') return forbidden(corsHeaders);
        return jsonResponse(await ingestAppleSpins(supabase, body), corsHeaders);

      case 'get_radio_targets':
        return jsonResponse(await getRadioTargets(supabase), corsHeaders);

      case 'get_outreach_stats':
        return jsonResponse(await getOutreachStats(supabase), corsHeaders);

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
  } catch (error) {
    console.error('control-center-api error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function jsonResponse(data: unknown, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function forbidden(headers: Record<string, string>) {
  return new Response(JSON.stringify({ error: 'hub key required' }), {
    status: 403,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Monday (UTC) of the week containing d — the snapshot bucket key.
function mondayOf(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay(); // 0=Sun..6=Sat
  dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return dt.toISOString().slice(0, 10);
}

/**
 * Ingest a weekly Apple Music for Artists radio-spins capture.
 * Body: {
 *   artist_id, captured_at?, snapshot_week?, period_start?, period_end?,
 *   plays: [{ song_id, song_name, station_id, call_sign, band, frequency,
 *             timezone, city, area, country, latitude, longitude, geo_id, spins }]
 * }
 * Upserts one row per (song_id, station_id, snapshot_week) into apple_station_plays,
 * then rolls station totals into radio_targets (warmth = already_playing) without
 * clobbering manual fields (contact_email, pitch_status, notes are not in the payload).
 */
async function ingestAppleSpins(
  supabase: ReturnType<typeof createClient>,
  body: any,
) {
  const artistId = String(body.artist_id || '').trim();
  const plays = Array.isArray(body.plays) ? body.plays : [];
  if (!artistId || plays.length === 0) {
    return { error: 'artist_id and non-empty plays[] required' };
  }

  const week = body.snapshot_week || mondayOf(new Date(body.captured_at || Date.now()));
  const periodStart = body.period_start ?? null;
  const periodEnd = body.period_end ?? null;

  const playRows = plays.map((p: any) => ({
    artist_id: artistId,
    song_id: String(p.song_id),
    song_name: p.song_name ?? null,
    station_id: String(p.station_id),
    station_call_sign: p.call_sign ?? null,
    band: p.band ?? null,
    frequency: p.frequency ?? null,
    timezone: p.timezone ?? null,
    city: p.city ?? null,
    area_name: p.area ?? null,
    country_code: p.country ?? null,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,
    geo_id: p.geo_id != null ? String(p.geo_id) : null,
    spins_total: Number(p.spins) || 0,
    period_start: periodStart,
    period_end: periodEnd,
    snapshot_week: week,
  }));

  const { error: upErr } = await supabase
    .from('apple_station_plays')
    .upsert(playRows, { onConflict: 'song_id,station_id,snapshot_week' });
  if (upErr) throw upErr;

  // Roll up into radio_targets (one row per station for this capture).
  const byStation = new Map<string, any>();
  for (const p of plays) {
    const sid = String(p.station_id);
    let t = byStation.get(sid);
    if (!t) {
      t = {
        station_id: sid,
        station_call_sign: p.call_sign ?? sid,
        station_type: 'radio',
        city: p.city ?? null,
        area_name: p.area ?? null,
        country_code: p.country ?? null,
        timezone: p.timezone ?? null,
        total_spins: 0,
        songs_played: [] as any[],
        warmth: 'already_playing',
        updated_at: new Date().toISOString(),
      };
      byStation.set(sid, t);
    }
    t.total_spins += Number(p.spins) || 0;
    t.songs_played.push({
      song_id: String(p.song_id),
      song_name: p.song_name ?? null,
      spins: Number(p.spins) || 0,
    });
  }
  const targetRows = [...byStation.values()];

  const { error: tErr } = await supabase
    .from('radio_targets')
    .upsert(targetRows, { onConflict: 'station_id' });
  if (tErr) throw tErr;

  return {
    ok: true,
    snapshot_week: week,
    plays_ingested: playRows.length,
    stations_upserted: targetRows.length,
  };
}

async function getRadioTargets(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from('radio_targets')
    .select('*')
    .order('total_spins', { ascending: false })
    .limit(500);
  if (error) throw error;
  return { targets: data || [] };
}

/** Cross-channel counts for admin Send center. */
async function getOutreachStats(supabase: ReturnType<typeof createClient>) {
  const dayAgo = new Date(Date.now() - 86400000).toISOString();

  const [
    { count: fanEmailSubs },
    { count: fanTelegramSubs },
    { count: pendingDrafts },
    { count: playlistEmails24h },
    { count: radioStations },
    { count: radioWithEmail },
    { count: radioNotPitched },
    { count: igQueue },
    { count: radioEmails24h },
  ] = await Promise.all([
    supabase.from('email_contacts').select('*', { count: 'exact', head: true }).eq('subscribed', true),
    supabase.from('telegram_subscribers').select('*', { count: 'exact', head: true }).eq('subscribed', true),
    supabase.from('outreach_drafts').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('pitch_log').select('*', { count: 'exact', head: true }).eq('method', 'email').eq('status', 'sent').gte('pitched_at', dayAgo),
    supabase.from('radio_targets').select('*', { count: 'exact', head: true }),
    supabase.from('radio_targets').select('*', { count: 'exact', head: true }).not('contact_email', 'is', null),
    supabase.from('radio_targets').select('*', { count: 'exact', head: true }).neq('pitch_status', 'pitched'),
    supabase.from('social_engagement_queue').select('*', { count: 'exact', head: true }).eq('platform', 'instagram').eq('status', 'pending'),
    supabase.from('radio_pitch_log').select('*', { count: 'exact', head: true }).eq('channel', 'email').eq('status', 'sent').gte('sent_at', dayAgo),
  ]);

  const { data: tgStats } = await supabase.from('telegram_inner_circle_stats').select('*').maybeSingle();

  return {
    fan_email_subscribers: fanEmailSubs ?? 0,
    fan_telegram_subscribers: fanTelegramSubs ?? 0,
    playlist_pending_drafts: pendingDrafts ?? 0,
    playlist_emails_24h: playlistEmails24h ?? 0,
    radio_stations: radioStations ?? 0,
    radio_with_email: radioWithEmail ?? 0,
    radio_ready_to_pitch: radioNotPitched ?? 0,
    radio_emails_24h: radioEmails24h ?? 0,
    instagram_dm_queue: igQueue ?? 0,
    telegram_stats: tgStats ?? null,
  };
}

async function getFanStats(supabase: ReturnType<typeof createClient>) {
  const userId = await resolveArtistUserId(supabase);

  // Lead counts (scoped via owning smart_link — lead.user_id is often null)
  const leadScope = 'id, smart_links!inner(user_id)';
  const { count: totalLeads } = await supabase
    .from('smart_link_leads')
    .select(leadScope, { count: 'exact', head: true })
    .eq('smart_links.user_id', userId);

  const { count: albumBuyers } = await supabase
    .from('smart_link_leads')
    .select(leadScope, { count: 'exact', head: true })
    .eq('smart_links.user_id', userId)
    .eq('album_purchased', true);

  const { count: merchConverted } = await supabase
    .from('smart_link_leads')
    .select(leadScope, { count: 'exact', head: true })
    .eq('smart_links.user_id', userId)
    .eq('converted', true);

  // Fan profile tiers
  const { data: fanProfiles } = await supabase
    .from('fan_profiles')
    .select('fan_tier')
    .eq('user_id', userId);

  const tiers = { casual: 0, engaged: 0, superfan: 0 };
  (fanProfiles || []).forEach((f: any) => {
    if (tiers[f.fan_tier as keyof typeof tiers] !== undefined) {
      tiers[f.fan_tier as keyof typeof tiers]++;
    }
  });

  // Platform follower totals from fan_data
  const { data: platformData } = await supabase
    .from('fan_data')
    .select('platform, total_interactions, total_streams, fan_identifier')
    .eq('user_id', userId)
    .in('fan_identifier', PLATFORM_STAT_IDENTIFIERS);

  const platforms: Record<string, any> = {};
  (platformData || []).forEach((p: any) => {
    platforms[p.platform] = {
      followers: p.total_interactions ?? 0,
      streams: p.total_streams ?? 0,
    };
  });

  return {
    total_leads: totalLeads ?? 0,
    album_buyers: albumBuyers ?? 0,
    merch_converted: merchConverted ?? 0,
    fan_tiers: tiers,
    platform_summary: platforms,
  };
}

async function getLeads(supabase: ReturnType<typeof createClient>) {
  const userId = await resolveArtistUserId(supabase);
  const { data, error } = await supabase
    .from('smart_link_leads')
    .select(`*, smart_links!inner (title, slug, user_id)`)
    .eq('smart_links.user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw error;

  const leads = data || [];
  const segments = {
    cold: leads.filter((l: any) => !l.converted && !l.album_purchased).length,
    album_only: leads.filter((l: any) => l.album_purchased && !l.converted).length,
    merch_only: leads.filter((l: any) => l.converted && !l.album_purchased).length,
    both: leads.filter((l: any) => l.converted && l.album_purchased).length,
    total: leads.length,
  };

  return { leads, segments };
}

async function getMomentumAlerts(supabase: ReturnType<typeof createClient>) {
  const userId = await resolveArtistUserId(supabase);
  const { data, error } = await supabase
    .from('momentum_events')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['new', 'active'])
    .order('detected_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return { alerts: data || [] };
}

async function getMarketingActions(supabase: ReturnType<typeof createClient>) {
  const userId = await resolveArtistUserId(supabase);
  const { data, error } = await supabase
    .from('marketing_actions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) throw error;
  return { actions: data || [] };
}

async function getPlatformMetrics(supabase: ReturnType<typeof createClient>) {
  const userId = await resolveArtistUserId(supabase);
  const { data, error } = await supabase
    .from('fan_data')
    .select('*')
    .eq('user_id', userId)
    .in('fan_identifier', PLATFORM_STAT_IDENTIFIERS);

  if (error) throw error;

  const metrics: Record<string, {
    followers: number;
    streams: number;
    name: string | null;
    metadata: unknown;
    updated_at: string | null;
    fan_identifier: string | null;
  }> = {};

  for (const row of data || []) {
    const platform = row.platform as string;
    const existing = metrics[platform];
    const preferRow =
      !existing ||
      row.fan_identifier === 'youtube_channel_stats' ||
      (existing.fan_identifier === 'youtube_chartmetric_stats' && row.fan_identifier !== 'youtube_chartmetric_stats');

    if (!preferRow) continue;

    metrics[platform] = {
      followers: row.total_interactions ?? 0,
      streams: row.total_streams ?? 0,
      name: row.fan_name,
      metadata: row.metadata,
      updated_at: row.updated_at,
      fan_identifier: row.fan_identifier,
    };
  }

  // Also grab latest analytics snapshot
  const { data: snapshot } = await supabase
    .from('analytics_snapshots')
    .select('*')
    .eq('user_id', userId)
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return { platforms: metrics, latest_snapshot: snapshot };
}

