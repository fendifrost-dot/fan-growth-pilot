import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

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

    const YOUTUBE_API_KEY = Deno.env.get('Fendi_Youtube_API_Key_1');
    if (!YOUTUBE_API_KEY) throw new Error('YouTube API key not configured');

    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const channelHandle = body.channel_handle || '@FendiFrost';
    let channelId = body.channel_id || null;

    // Step 1: Resolve channel ID from handle/search if not provided
    if (!channelId) {
      // Try search by handle first
      const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(channelHandle)}&maxResults=1&key=${YOUTUBE_API_KEY}`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();

      if (!searchRes.ok) {
        console.error('YouTube search error:', searchData);
        throw new Error(`YouTube API error: ${searchData.error?.message || 'Unknown'}`);
      }

      if (searchData.items?.length > 0) {
        channelId = searchData.items[0].snippet.channelId;
      } else {
        throw new Error(`Channel not found for: ${channelHandle}`);
      }
    }

    // Step 2: Get channel statistics
    const channelUrl = `${YOUTUBE_API_BASE}/channels?part=statistics,snippet,contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    const channelRes = await fetch(channelUrl);
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
      const playlistUrl = `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=10&key=${YOUTUBE_API_KEY}`;
      const playlistRes = await fetch(playlistUrl);
      const playlistData = await playlistRes.json();

      if (playlistRes.ok && playlistData.items?.length) {
        const videoIds = playlistData.items.map((item: any) => item.snippet.resourceId.videoId).join(',');
        
        const videosUrl = `${YOUTUBE_API_BASE}/videos?part=statistics,snippet&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
        const videosRes = await fetch(videosUrl);
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
          // Sort by views descending
          topVideos.sort((a: any, b: any) => b.views - a.views);
        }
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
      updated_at: new Date().toISOString(),
    };

    // Step 4: Persist to fan_data
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
        source: 'youtube_data_api',
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
