import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const SOUNDCLOUD_API_BASE = 'https://api.soundcloud.com';

interface SoundCloudTokenResponse {
  access_token: string;
  expires_in?: number;
}

interface SoundCloudTrack {
  id: number;
  title: string;
  artwork_url: string | null;
  playback_count: number;
  likes_count: number;
  favoritings_count?: number;
  comment_count: number;
  reposts_count: number;
  duration: number;
  permalink_url: string;
  created_at: string;
}

interface MappedTrack {
  id: number;
  title: string;
  artwork_url: string | null;
  playback_count: number;
  likes_count: number;
  comment_count: number;
  reposts_count: number;
  duration_ms: number;
  permalink_url: string;
  created_at: string;
}

async function refreshAccessToken(refreshToken: string): Promise<SoundCloudTokenResponse | null> {
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
    console.error('[soundcloud-stats] Token refresh failed:', res.status, await res.text());
    return null;
  }
  return await res.json();
}

/**
 * Fetch ALL tracks by paginating through the SoundCloud API.
 * Uses linked_partitioning to get next_href for pagination.
 */
async function fetchAllTracks(accessToken: string): Promise<SoundCloudTrack[]> {
  const allTracks: SoundCloudTrack[] = [];
  let url: string | null = `${SOUNDCLOUD_API_BASE}/me/tracks?limit=200&linked_partitioning=1`;
  let pageCount = 0;
  const maxPages = 50; // Safety limit to prevent infinite loops

  while (url && pageCount < maxPages) {
    pageCount++;
    console.log(`[soundcloud-stats] Fetching tracks page ${pageCount}...`);
    
    const res = await fetch(url, {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    
    if (!res.ok) {
      console.error('[soundcloud-stats] Tracks page error:', res.status);
      break;
    }
    
    const data = await res.json();
    const tracks = data.collection || data;
    
    if (Array.isArray(tracks)) {
      allTracks.push(...tracks);
    }
    
    url = data.next_href || null;
  }

  console.log(`[soundcloud-stats] Fetched ${allTracks.length} total tracks across ${pageCount} pages`);
  return allTracks;
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

    if (connError) {
      console.error('[soundcloud-stats] Connection query error:', connError);
    }

    if (!connection?.access_token) {
      console.error('[soundcloud-stats] No access token found!');
      throw new Error('SoundCloud not connected. Please connect via OAuth first.');
    }

    let accessToken = connection.access_token;

    // Check if token is expired and refresh if needed
    const isExpired = connection.token_expires_at && new Date(connection.token_expires_at) < new Date();
    
    if (isExpired && connection.refresh_token) {
      console.log('[soundcloud-stats] Token expired, refreshing...');
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
        console.log('[soundcloud-stats] Token refreshed successfully');
      } else {
        throw new Error('Failed to refresh SoundCloud token. Please reconnect.');
      }
    }

    // Fetch user data
    console.log('[soundcloud-stats] Fetching /me from SoundCloud API...');
    const userRes = await fetch(`${SOUNDCLOUD_API_BASE}/me`, {
      headers: { Authorization: `OAuth ${accessToken}` },
    });

    console.log('[soundcloud-stats] /me response status:', userRes.status);
    
    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error('[soundcloud-stats] SoundCloud /me error:', userRes.status, errText);
      throw new Error(`SoundCloud API error: ${userRes.status}`);
    }

    const scUser = await userRes.json();
    console.log('[soundcloud-stats] SoundCloud user:', scUser.username, 'tracks:', scUser.track_count);

    // Fetch ALL tracks with pagination
    const allTracks = await fetchAllTracks(accessToken);

    // Map tracks to our format
    const mappedTracks: MappedTrack[] = allTracks.map((t: SoundCloudTrack) => ({
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

    // Sort by plays descending to get top tracks
    mappedTracks.sort((a, b) => b.playback_count - a.playback_count);

    // Calculate all-time totals
    const totalPlays = mappedTracks.reduce((sum, t) => sum + t.playback_count, 0);
    const totalLikes = mappedTracks.reduce((sum, t) => sum + t.likes_count, 0);
    const totalComments = mappedTracks.reduce((sum, t) => sum + t.comment_count, 0);
    const totalReposts = mappedTracks.reduce((sum, t) => sum + t.reposts_count, 0);
    
    console.log('[soundcloud-stats] All-time totals:');
    console.log(`  - Total plays: ${totalPlays}`);
    console.log(`  - Total likes: ${totalLikes}`);
    console.log(`  - Total comments: ${totalComments}`);
    console.log(`  - Total reposts: ${totalReposts}`);

    // Get top 10 tracks
    const topTracks = mappedTracks.slice(0, 10);

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
      total_likes: totalLikes,
      total_comments: totalComments,
      total_reposts: totalReposts,
      top_tracks: topTracks,
      profile_url: scUser.permalink_url,
      has_oauth: true,
      updated_at: new Date().toISOString(),
    };

    // Persist to fan_data with stable keys
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
        total_likes: result.total_likes,
        total_comments: result.total_comments,
        total_reposts: result.total_reposts,
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
      console.log('[soundcloud-stats] Updating existing fan_data row:', existing.id);
      const { error: updateErr } = await supabase
        .from('fan_data')
        .update({ ...fanDataPayload, last_interaction_at: now, updated_at: now })
        .eq('id', existing.id);
      if (updateErr) console.error('[soundcloud-stats] fan_data update error:', updateErr);
    } else {
      console.log('[soundcloud-stats] Inserting new fan_data row');
      const { error: insertErr } = await supabase
        .from('fan_data')
        .insert({ ...fanDataPayload, user_id: user.id, last_interaction_at: now });
      if (insertErr) console.error('[soundcloud-stats] fan_data insert error:', insertErr);
    }

    console.log('[soundcloud-stats] ========== RETURNING SUCCESS ==========');
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[soundcloud-stats] ERROR:', error);
    const statusCode = error instanceof Error && error.message === 'Unauthorized' ? 401 : 500;
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
