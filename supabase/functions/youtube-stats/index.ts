import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2/reports';

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
  const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret || !refreshToken) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) return null;
  return await res.json();
}

async function fetchAnalytics(accessToken: string, channelId: string) {
  const endDate = new Date().toISOString().split('T')[0];
  const startDate30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const startDate90 = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

  const headers = { Authorization: `Bearer ${accessToken}` };

  // Fetch multiple analytics reports in parallel
  const [overviewRes, demographicsRes, trafficRes, dailyRes] = await Promise.all([
    // Overview: watch time, views, subscribers gained/lost (30 days)
    fetch(`${YOUTUBE_ANALYTICS_BASE}?ids=channel==${channelId}&startDate=${startDate30}&endDate=${endDate}&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,dislikes,shares,comments&dimensions=&sort=-views`, { headers }),
    // Demographics: age group + gender (90 days)
    fetch(`${YOUTUBE_ANALYTICS_BASE}?ids=channel==${channelId}&startDate=${startDate90}&endDate=${endDate}&metrics=viewerPercentage&dimensions=ageGroup,gender&sort=-viewerPercentage`, { headers }),
    // Traffic sources (30 days)
    fetch(`${YOUTUBE_ANALYTICS_BASE}?ids=channel==${channelId}&startDate=${startDate30}&endDate=${endDate}&metrics=views,estimatedMinutesWatched&dimensions=insightTrafficSourceType&sort=-views`, { headers }),
    // Daily views (30 days)
    fetch(`${YOUTUBE_ANALYTICS_BASE}?ids=channel==${channelId}&startDate=${startDate30}&endDate=${endDate}&metrics=views,estimatedMinutesWatched,subscribersGained&dimensions=day&sort=day`, { headers }),
  ]);

  const [overview, demographics, traffic, daily] = await Promise.all([
    overviewRes.ok ? overviewRes.json() : null,
    demographicsRes.ok ? demographicsRes.json() : null,
    trafficRes.ok ? trafficRes.json() : null,
    dailyRes.ok ? dailyRes.json() : null,
  ]);

  return {
    overview: overview?.rows?.[0] ? {
      views_30d: overview.rows[0][0],
      watch_time_minutes_30d: overview.rows[0][1],
      avg_view_duration_seconds: overview.rows[0][2],
      subscribers_gained_30d: overview.rows[0][3],
      subscribers_lost_30d: overview.rows[0][4],
      likes_30d: overview.rows[0][5],
      dislikes_30d: overview.rows[0][6],
      shares_30d: overview.rows[0][7],
      comments_30d: overview.rows[0][8],
    } : null,
    demographics: demographics?.rows?.map((r: any[]) => ({
      age_group: r[0],
      gender: r[1],
      viewer_percentage: r[2],
    })) || [],
    traffic_sources: traffic?.rows?.map((r: any[]) => ({
      source: r[0],
      views: r[1],
      watch_time_minutes: r[2],
    })) || [],
    daily_stats: daily?.rows?.map((r: any[]) => ({
      date: r[0],
      views: r[1],
      watch_time_minutes: r[2],
      subscribers_gained: r[3],
    })) || [],
  };
}

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

    const channelHandle = body.channel_handle || '@FendiFrost';

    // Check if user has OAuth connection for YouTube
    const { data: connection } = await supabase
      .from('platform_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('platform', 'YouTube')
      .eq('is_connected', true)
      .maybeSingle();

    let oauthAccessToken: string | null = null;
    let channelId: string | null = null;

    if (connection?.access_token) {
      // Check if token is expired and refresh if needed
      const isExpired = connection.token_expires_at && new Date(connection.token_expires_at) < new Date();
      
      if (isExpired && connection.refresh_token) {
        const refreshed = await refreshAccessToken(connection.refresh_token);
        if (refreshed) {
          oauthAccessToken = refreshed.access_token;
          const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
          await supabase
            .from('platform_connections')
            .update({ access_token: refreshed.access_token, token_expires_at: newExpiry, updated_at: new Date().toISOString() })
            .eq('id', connection.id);
        }
      } else {
        oauthAccessToken = connection.access_token;
      }

      channelId = connection.platform_user_id || (connection.metadata as any)?.channel_id || null;
    }

    // Fallback: use API key if no OAuth
    const YOUTUBE_API_KEY = Deno.env.get('Fendi_Youtube_API_Key_1');

    if (!oauthAccessToken && !YOUTUBE_API_KEY) {
      throw new Error('No YouTube credentials available. Connect YouTube or configure API key.');
    }

    // Step 1: Resolve channel ID
    if (!channelId) {
      if (oauthAccessToken) {
        const res = await fetch(`${YOUTUBE_API_BASE}/channels?part=snippet&mine=true`, {
          headers: { Authorization: `Bearer ${oauthAccessToken}` },
        });
        const data = await res.json();
        channelId = data.items?.[0]?.id || null;
      }

      if (!channelId) {
        // Try forHandle first (works for @handles)
        const handleClean = channelHandle.startsWith('@') ? channelHandle.substring(1) : channelHandle;
        const handleUrl = `${YOUTUBE_API_BASE}/channels?part=id&forHandle=${encodeURIComponent(handleClean)}&key=${YOUTUBE_API_KEY}`;
        const handleRes = await fetch(handleUrl);
        const handleData = await handleRes.json();
        channelId = handleData.items?.[0]?.id || null;

        // Fallback to search if forHandle fails
        if (!channelId) {
          const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(channelHandle)}&maxResults=1&key=${YOUTUBE_API_KEY}`;
          const searchRes = await fetch(searchUrl);
          const searchData = await searchRes.json();
          if (!searchRes.ok) throw new Error(`YouTube API error: ${searchData.error?.message || 'Unknown'}`);
          channelId = searchData.items?.[0]?.snippet?.channelId || null;
        }

        if (!channelId) throw new Error(`Channel not found for: ${channelHandle}`);
      }
    }

    // Step 2: Get channel statistics
    const channelHeaders: Record<string, string> = oauthAccessToken
      ? { Authorization: `Bearer ${oauthAccessToken}` }
      : {};
    const channelUrlKey = oauthAccessToken ? '' : `&key=${YOUTUBE_API_KEY}`;
    const channelUrl = `${YOUTUBE_API_BASE}/channels?part=statistics,snippet,contentDetails&id=${channelId}${channelUrlKey}`;
    const channelRes = await fetch(channelUrl, { headers: channelHeaders });
    const channelData = await channelRes.json();

    if (!channelRes.ok || !channelData.items?.length) {
      throw new Error('Failed to fetch channel data');
    }

    const channel = channelData.items[0];
    const stats = channel.statistics;
    const snippet = channel.snippet;

    // Step 3: Get top/recent videos
    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    let topVideos: any[] = [];

    if (uploadsPlaylistId) {
      const playlistUrlKey = oauthAccessToken ? '' : `&key=${YOUTUBE_API_KEY}`;
      const playlistUrl = `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=10${playlistUrlKey}`;
      const playlistRes = await fetch(playlistUrl, { headers: channelHeaders });
      const playlistData = await playlistRes.json();

      if (playlistRes.ok && playlistData.items?.length) {
        const videoIds = playlistData.items.map((item: any) => item.snippet.resourceId.videoId).join(',');
        const videosUrlKey = oauthAccessToken ? '' : `&key=${YOUTUBE_API_KEY}`;
        const videosUrl = `${YOUTUBE_API_BASE}/videos?part=statistics,snippet&id=${videoIds}${videosUrlKey}`;
        const videosRes = await fetch(videosUrl, { headers: channelHeaders });
        const videosData = await videosRes.json();

        if (videosRes.ok && videosData.items) {
          topVideos = videosData.items.map((v: any) => ({
            id: v.id,
            title: v.snippet.title,
            thumbnail: v.snippet.thumbnails?.medium?.url,
            published_at: v.snippet.publishedAt,
            views: parseInt(v.statistics.viewCount || '0'),
            likes: parseInt(v.statistics.likeCount || '0'),
            comments: parseInt(v.statistics.commentCount || '0'),
          }));
          topVideos.sort((a: any, b: any) => b.views - a.views);
        }
      }
    }

    // Step 4: Fetch YouTube Analytics if OAuth available
    let analytics = null;
    if (oauthAccessToken && channelId) {
      try {
        analytics = await fetchAnalytics(oauthAccessToken, channelId);
      } catch (err) {
        console.error('Analytics fetch failed (non-fatal):', err);
      }
    }

    const result = {
      channel_id: channelId,
      channel_name: snippet.title,
      channel_thumbnail: snippet.thumbnails?.medium?.url,
      subscribers: parseInt(stats.subscriberCount || '0'),
      total_views: parseInt(stats.viewCount || '0'),
      video_count: parseInt(stats.videoCount || '0'),
      top_videos: topVideos,
      analytics,
      has_oauth: !!oauthAccessToken,
      updated_at: new Date().toISOString(),
    };

    // Step 5: Persist to fan_data
    const now = new Date().toISOString();
    const fanDataPayload = {
      platform: 'YouTube',
      fan_identifier: 'youtube_channel_stats',
      fan_name: snippet.title,
      total_streams: result.total_views,
      total_interactions: result.subscribers,
      metadata: {
        channel_id: channelId,
        subscribers: result.subscribers,
        total_views: result.total_views,
        video_count: result.video_count,
        channel_thumbnail: result.channel_thumbnail,
        top_videos: topVideos.slice(0, 5),
        analytics,
        has_oauth: !!oauthAccessToken,
        source: oauthAccessToken ? 'youtube_oauth' : 'youtube_data_api',
      },
    };

    const { data: existing } = await supabase
      .from('fan_data')
      .select('id')
      .eq('user_id', user.id)
      .eq('platform', 'YouTube')
      .eq('fan_identifier', 'youtube_channel_stats')
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
    console.error('Error in youtube-stats:', error);
    const statusCode = error instanceof Error && error.message === 'Unauthorized' ? 401 : 500;
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
