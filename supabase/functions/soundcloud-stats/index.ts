import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const SOUNDCLOUD_API_BASE = 'https://api.soundcloud.com';

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in?: number } | null> {
  const clientId = Deno.env.get('SOUNDCLOUD_CLIENT_ID');
  const clientSecret = Deno.env.get('SOUNDCLOUD_CLIENT_SECRET');
  if (!clientId || !clientSecret || !refreshToken) return null;

  const res = await fetch('https://secure.soundcloud.com/oauth/token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json; charset=utf-8',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    console.error('Token refresh failed:', res.status, await res.text());
    return null;
  }
  return await res.json();
}

Deno.serve(async (req) => {
  console.log('[soundcloud-stats] ========== FUNCTION INVOKED ==========');
  
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
    
    console.log('[soundcloud-stats] Authenticated user:', user.id);

    // Check if user has OAuth connection for SoundCloud
    console.log('[soundcloud-stats] Querying platform_connections...');
    const { data: connection, error: connError } = await supabase
      .from('platform_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('platform', 'SoundCloud')
      .eq('is_connected', true)
      .maybeSingle();

    console.log('[soundcloud-stats] Connection query error:', connError);
    console.log('[soundcloud-stats] Connection found:', !!connection);
    if (connection) {
      console.log('[soundcloud-stats] Connection ID:', connection.id);
      console.log('[soundcloud-stats] is_connected:', connection.is_connected);
      console.log('[soundcloud-stats] access_token present:', !!connection.access_token, 'length:', connection.access_token?.length);
      console.log('[soundcloud-stats] username:', connection.username);
    }

    if (!connection?.access_token) {
      console.error('[soundcloud-stats] No access token found!');
      throw new Error('SoundCloud not connected. Please connect via OAuth first.');
    }

    let accessToken = connection.access_token;

    // Check if token is expired and refresh if needed
    const isExpired = connection.token_expires_at && new Date(connection.token_expires_at) < new Date();
    
    if (isExpired && connection.refresh_token) {
      const refreshed = await refreshAccessToken(connection.refresh_token);
      if (refreshed) {
        accessToken = refreshed.access_token;
        const newExpiry = refreshed.expires_in 
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() 
          : null;
        await supabase
          .from('platform_connections')
          .update({ 
            access_token: refreshed.access_token, 
            token_expires_at: newExpiry, 
            updated_at: new Date().toISOString() 
          })
          .eq('id', connection.id);
      } else {
        throw new Error('Failed to refresh SoundCloud token. Please reconnect.');
      }
    }

    // Fetch user data
    const userRes = await fetch(`${SOUNDCLOUD_API_BASE}/me`, {
      headers: { Authorization: `OAuth ${accessToken}` },
    });

    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error('SoundCloud /me error:', userRes.status, errText);
      throw new Error(`SoundCloud API error: ${userRes.status}`);
    }

    const scUser = await userRes.json();

    // Fetch recent tracks
    let topTracks: any[] = [];
    try {
      const tracksRes = await fetch(`${SOUNDCLOUD_API_BASE}/me/tracks?limit=10`, {
        headers: { Authorization: `OAuth ${accessToken}` },
      });
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
      has_oauth: true,
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
        source: 'soundcloud_oauth',
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
