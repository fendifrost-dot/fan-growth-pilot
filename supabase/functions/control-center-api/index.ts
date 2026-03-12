import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authenticate via shared secret
    const apiKey = req.headers.get('x-api-key');
    const expectedKey = Deno.env.get('FANFUEL_HUB_KEY');

    if (!expectedKey || !apiKey || apiKey !== expectedKey) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { action } = await req.json();

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

async function getFanStats(supabase: any) {
  // Lead counts
  const { count: totalLeads } = await supabase
    .from('smart_link_leads')
    .select('*', { count: 'exact', head: true });

  const { count: albumBuyers } = await supabase
    .from('smart_link_leads')
    .select('*', { count: 'exact', head: true })
    .eq('album_purchased', true);

  const { count: merchConverted } = await supabase
    .from('smart_link_leads')
    .select('*', { count: 'exact', head: true })
    .eq('converted', true);

  // Fan profile tiers
  const { data: fanProfiles } = await supabase
    .from('fan_profiles')
    .select('fan_tier');

  const tiers = { casual: 0, engaged: 0, superfan: 0 };
  (fanProfiles || []).forEach((f: any) => {
    if (tiers[f.fan_tier as keyof typeof tiers] !== undefined) {
      tiers[f.fan_tier as keyof typeof tiers]++;
    }
  });

  // Platform follower totals from fan_data
  const { data: platformData } = await supabase
    .from('fan_data')
    .select('platform, total_interactions, total_streams')
    .in('fan_identifier', ['spotify_artist_stats', 'instagram_stats', 'facebook_stats', 'youtube_channel_stats']);

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

async function getLeads(supabase: any) {
  const { data, error } = await supabase
    .from('smart_link_leads')
    .select(`*, smart_links (title, slug)`)
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

async function getMomentumAlerts(supabase: any) {
  const { data, error } = await supabase
    .from('momentum_events')
    .select('*')
    .in('status', ['new', 'active'])
    .order('detected_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return { alerts: data || [] };
}

async function getMarketingActions(supabase: any) {
  const { data, error } = await supabase
    .from('marketing_actions')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) throw error;
  return { actions: data || [] };
}

async function getPlatformMetrics(supabase: any) {
  const { data, error } = await supabase
    .from('fan_data')
    .select('*')
    .in('fan_identifier', [
      'spotify_artist_stats',
      'instagram_stats',
      'facebook_stats',
      'youtube_channel_stats',
    ]);

  if (error) throw error;

  const metrics: Record<string, any> = {};
  (data || []).forEach((row: any) => {
    metrics[row.platform] = {
      followers: row.total_interactions ?? 0,
      streams: row.total_streams ?? 0,
      name: row.fan_name,
      metadata: row.metadata,
      updated_at: row.updated_at,
    };
  });

  // Also grab latest analytics snapshot
  const { data: snapshot } = await supabase
    .from('analytics_snapshots')
    .select('*')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return { platforms: metrics, latest_snapshot: snapshot };
}
