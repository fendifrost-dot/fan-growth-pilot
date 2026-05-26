import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isPlaylistAgentAction, runPlaylistAgentAction } from '../_shared/playlist-agent-run.ts';

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
    // Authenticate via shared secret — accept x-api-key, Authorization: Bearer, or apikey header
    const xApiKey = req.headers.get('x-api-key');
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const anonApiKey = req.headers.get('apikey');
    const providedKey = (xApiKey || bearerToken || anonApiKey || '').trim();
    const expectedKey = (Deno.env.get('FANFUEL_HUB_KEY') || '').trim();

    if (!expectedKey || !providedKey || providedKey !== expectedKey) {
      console.error('Auth failed', {
        hasExpectedKey: !!expectedKey,
        expectedKeyLen: expectedKey.length,
        providedKeyLen: providedKey.length,
        headerUsed: xApiKey ? 'x-api-key' : bearerToken ? 'bearer' : anonApiKey ? 'apikey' : 'none',
      });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

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

