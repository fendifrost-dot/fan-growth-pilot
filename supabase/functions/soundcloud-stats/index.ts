import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const SOUNDCLOUD_API_BASE = 'https://api.soundcloud.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Authenticate user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) throw new Error('Unauthorized');

    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const SOUNDCLOUD_CLIENT_ID = Deno.env.get('Fendi_SoundCloud_API');
    if (!SOUNDCLOUD_CLIENT_ID) {
      throw new Error('SoundCloud API key not configured');
    }

    // Check if user has a SoundCloud platform connection with a profile URL
    const { data: connection } = await supabase
      .from('platform_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('platform', 'SoundCloud')
      .eq('is_connected', true)
      .maybeSingle();

    // Resolve the SoundCloud user - use profile URL from connection, body, or default
    const profileUrl = body.profile_url || connection?.profile_url || 'https://soundcloud.com/fendifrost';
    
    // Extract username from URL
    const urlMatch = profileUrl.match(/soundcloud\.com\/([^/?#]+)/);
    const scUsername = urlMatch?.[1] || body.username || 'fendifrost';

    // Fetch user data via SoundCloud API
    const userRes = await fetch(
      `${SOUNDCLOUD_API_BASE}/resolve?url=https://soundcloud.com/${scUsername}&client_id=${SOUNDCLOUD_CLIENT_ID}`
    );

    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error('SoundCloud resolve error:', userRes.status, errText);
      throw new Error(`SoundCloud API error: ${userRes.status} - Could not resolve user "${scUsername}"`);
    }

    const scUser = await userRes.json();

    // Fetch recent tracks
    let topTracks: any[] = [];
    try {
      const tracksRes = await fetch(
        `${SOUNDCLOUD_API_BASE}/users/${scUser.id}/tracks?client_id=${SOUNDCLOUD_CLIENT_ID}&limit=10&linked_partitioning=1`
      );
      if (tracksRes.ok) {
        const tracksData = await tracksRes.json();
        const tracks = tracksData.collection || tracksData;
        if (Array.isArray(tracks)) {
          topTracks = tracks.map((t: any) => ({
            id: t.id,
            title: t.title,
            artwork_url: t.artwork_url,
            playback_count: t.playback_count || 0,
            likes_count: t.likes_count || t.favoritings_count || 0,
            comment_count: t.comment_count || 0,
            reposts_count: t.reposts_count || 0,
            duration_ms: t.duration || 0,
            permalink_url: t.permalink_url,
            created_at: t.created_at,
          }));
          topTracks.sort((a: any, b: any) => b.playback_count - a.playback_count);
        }
      }
    } catch (err) {
      console.error('Error fetching SoundCloud tracks (non-fatal):', err);
    }

    const totalPlays = topTracks.reduce((sum: number, t: any) => sum + t.playback_count, 0);

    const result = {
      user_id: scUser.id,
      username: scUser.username,
      display_name: scUser.full_name || scUser.username,
      avatar_url: scUser.avatar_url,
      followers: scUser.followers_count || 0,
      following: scUser.followings_count || 0,
      track_count: scUser.track_count || 0,
      playlist_count: scUser.playlist_count || 0,
      total_plays: totalPlays,
      top_tracks: topTracks.slice(0, 5),
      profile_url: scUser.permalink_url,
      updated_at: new Date().toISOString(),
    };

    // Persist to fan_data
    const now = new Date().toISOString();
    const fanDataPayload = {
      platform: 'SoundCloud',
      fan_identifier: 'soundcloud_user_stats',
      fan_name: result.display_name,
      total_streams: result.total_plays,
      total_interactions: result.followers,
      metadata: {
        soundcloud_user_id: result.user_id,
        username: result.username,
        followers: result.followers,
        following: result.following,
        track_count: result.track_count,
        playlist_count: result.playlist_count,
        total_plays: result.total_plays,
        avatar_url: result.avatar_url,
        top_tracks: result.top_tracks,
        source: 'soundcloud_api',
      },
    };

    const { data: existing } = await supabase
      .from('fan_data')
      .select('id')
      .eq('user_id', user.id)
      .eq('platform', 'SoundCloud')
      .eq('fan_identifier', 'soundcloud_user_stats')
      .maybeSingle();

    if (existing) {
      await supabase
        .from('fan_data')
        .update({ ...fanDataPayload, last_interaction_at: now, updated_at: now })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('fan_data')
        .insert({ ...fanDataPayload, user_id: user.id, last_interaction_at: now });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in soundcloud-stats:', error);
    const statusCode = error instanceof Error && error.message === 'Unauthorized' ? 401 : 500;
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
