/**
 * INTERNAL: Manual push of Spotify/IG/FB into fan_data. Prefer scrape-chartmetric for scheduled refresh.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    // Accept stats from request body (sourced from Chartmetric by the caller)
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok, use defaults */ }

    const spotifyFollowers = body.spotify_followers;
    const monthlyListeners = body.monthly_listeners;
    const igFollowers = body.ig_followers;
    const fbFollowers = body.fb_followers;

    if (
      spotifyFollowers == null ||
      monthlyListeners == null ||
      igFollowers == null ||
      fbFollowers == null
    ) {
      return new Response(
        JSON.stringify({
          error: 'Missing stats in request body. Pass spotify_followers, monthly_listeners, ig_followers, fb_followers (or use scrape-chartmetric).',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const now = new Date().toISOString();

    const platforms = [
      {
        platform: 'Spotify',
        fan_identifier: 'spotify_artist_stats',
        fan_name: 'Fendi Frost',
        total_streams: monthlyListeners,
        total_interactions: spotifyFollowers,
        metadata: { monthly_listeners: monthlyListeners, followers: spotifyFollowers, source: 'chartmetric' },
      },
      {
        platform: 'Instagram',
        fan_identifier: 'instagram_stats',
        fan_name: 'Fendi Frost',
        total_interactions: igFollowers,
        metadata: { followers: igFollowers, source: 'chartmetric' },
      },
      {
        platform: 'Facebook',
        fan_identifier: 'facebook_stats',
        fan_name: 'Fendi Frost',
        total_interactions: fbFollowers,
        metadata: { followers: fbFollowers, source: 'chartmetric' },
      },
    ];

    for (const platformData of platforms) {
      const { data: existing } = await supabase
        .from('fan_data')
        .select('id')
        .eq('user_id', user.id)
        .eq('platform', platformData.platform)
        .eq('fan_identifier', platformData.fan_identifier)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('fan_data')
          .update({ ...platformData, last_interaction_at: now, updated_at: now })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('fan_data')
          .insert({ ...platformData, user_id: user.id, last_interaction_at: now });
      }
    }

    const result = {
      spotify: { followers: spotifyFollowers, monthly_listeners: monthlyListeners },
      instagram: { followers: igFollowers },
      facebook: { followers: fbFollowers },
      updated_at: now,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in fetch-public-spotify-data:', error);
    const statusCode = error instanceof Error && error.message === 'Unauthorized' ? 401 : 500;
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

