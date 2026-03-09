import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const CHARTMETRIC_URL = 'https://app.chartmetric.com/artist/895835';

function parseNumber(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').trim();
  const match = cleaned.match(/([\d.]+)\s*([KMBkmb])?/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') return Math.round(num * 1000);
  if (suffix === 'M') return Math.round(num * 1000000);
  if (suffix === 'B') return Math.round(num * 1000000000);
  return Math.round(num);
}

interface ScrapedData {
  spotify_followers: number;
  monthly_listeners: number;
  playlist_count: number;
  playlist_reach: number;
  ig_followers: number;
  x_followers: number;
  fb_followers: number;
  shazam_count: number;
  tiktok_post_count: number;
  tiktok_top_video_views: number;
  youtube_most_popular_video: number;
  pandora_monthly_listeners: number;
  pandora_streams: number;
  chartmetric_rank: number;
  primary_market: string;
  secondary_market: string;
  top_tracks: { name: string; streams: number }[];
  similar_artists: { name: string; country: string; genre: string }[];
  momentum_alerts: string[];
}

function parseChartmetricMarkdown(markdown: string): ScrapedData {
  const data: ScrapedData = {
    spotify_followers: 0,
    monthly_listeners: 0,
    playlist_count: 0,
    playlist_reach: 0,
    ig_followers: 0,
    x_followers: 0,
    fb_followers: 0,
    shazam_count: 0,
    tiktok_post_count: 0,
    tiktok_top_video_views: 0,
    youtube_most_popular_video: 0,
    pandora_monthly_listeners: 0,
    pandora_streams: 0,
    chartmetric_rank: 0,
    primary_market: '',
    secondary_market: '',
    top_tracks: [],
    similar_artists: [],
    momentum_alerts: [],
  };

  const lines = markdown.split('\n');

  // Extract momentum alerts (🔥 and 🏆 lines)
  for (const line of lines) {
    if ((line.includes('🔥') || line.includes('🏆')) && line.includes('attained')) {
      data.momentum_alerts.push(line.replace(/🔥|🏆/g, '').trim());
    }
  }

  // Quick Social Stats section
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const nextLine = (lines[i + 1] || '').trim();
    const nextNextLine = (lines[i + 2] || '').trim();

    // Pattern: label on one line, icon on next, value on the line after
    if (line === 'IG Followers') {
      // Value is 2 lines down (past the icon line)
      const valLine = lines.slice(i + 1, i + 4).find(l => /^\d/.test(l.trim()));
      if (valLine) data.ig_followers = parseNumber(valLine.trim());
    }
    if (line === 'Spotify Followers' && !lines[i - 2]?.includes('Streaming Stats')) {
      const valLine = lines.slice(i + 1, i + 4).find(l => /^\d/.test(l.trim()));
      if (valLine) data.spotify_followers = parseNumber(valLine.trim());
    }
    if (line === 'X Followers') {
      const valLine = lines.slice(i + 1, i + 4).find(l => /^\d/.test(l.trim()));
      if (valLine) data.x_followers = parseNumber(valLine.trim());
    }
    if (line === 'Facebook Followers') {
      const valLine = lines.slice(i + 1, i + 4).find(l => /^\d/.test(l.trim()));
      if (valLine) data.fb_followers = parseNumber(valLine.trim());
    }

    // Monthly Listeners (in the hero section)
    if (line === 'Monthly Listeners' && i < 50) {
      // Look backward for the value
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const val = lines[j].trim();
        if (/^[\d.]+[KMB]?$/i.test(val)) {
          data.monthly_listeners = parseNumber(val);
          break;
        }
      }
    }

    // Chartmetric rank
    if (/^\d[\d,.]*[KMB]?st$/i.test(line)) {
      data.chartmetric_rank = parseNumber(line.replace(/st$/i, ''));
    }

    // Streaming Stats section
    if (line === 'Followers' && lines.slice(Math.max(0, i - 5), i).some(l => l.includes('Spotify'))) {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine && data.spotify_followers === 0) data.spotify_followers = parseNumber(valLine.trim());
    }
    if (line === 'Playlist Count') {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.playlist_count = parseNumber(valLine.trim());
    }
    if (line === 'Playlist Reach') {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.playlist_reach = parseNumber(valLine.trim());
    }

    // Shazam
    if (line === 'Shazams') {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.shazam_count = parseNumber(valLine.trim());
    }

    // TikTok
    if (line === 'Post Count') {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.tiktok_post_count = parseNumber(valLine.trim());
    }
    if (line === 'Top Video Views') {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.tiktok_top_video_views = parseNumber(valLine.trim());
    }

    // YouTube
    if (line === 'mostPopularVideo') {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.youtube_most_popular_video = parseNumber(valLine.trim());
    }

    // Pandora
    if (line === 'Monthly Listeners' && lines.slice(Math.max(0, i - 5), i).some(l => l.includes('Pandora'))) {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.pandora_monthly_listeners = parseNumber(valLine.trim());
    }
    if (line === 'Streams' && lines.slice(Math.max(0, i - 5), i).some(l => l.includes('Pandora'))) {
      const valLine = lines.slice(i + 1, i + 3).find(l => /^\d/.test(l.trim()));
      if (valLine) data.pandora_streams = parseNumber(valLine.trim());
    }

    // Audience Summary
    if (line === 'Primary Market') {
      const valLine = lines.slice(i + 1, i + 3).find(l => l.trim().length > 0 && !l.includes('!['));
      if (valLine) data.primary_market = valLine.trim();
    }
    if (line === 'Secondary') {
      const valLine = lines.slice(i + 1, i + 3).find(l => l.trim().length > 0 && !l.includes('!['));
      if (valLine) data.secondary_market = valLine.trim();
    }
  }

  // Parse top tracks from markdown links
  const trackPattern = /\*\*(.+?)\*\*.*?([\d.]+[KMB]?)\s*Streams/gi;
  let trackMatch;
  const seenTracks = new Set<string>();
  while ((trackMatch = trackPattern.exec(markdown)) !== null) {
    const name = trackMatch[1].trim();
    if (!seenTracks.has(name)) {
      seenTracks.add(name);
      data.top_tracks.push({ name, streams: parseNumber(trackMatch[2]) });
    }
  }

  // Parse similar artists (first occurrence only, before duplicates)
  const similarSection = markdown.indexOf('### Similar Artists');
  if (similarSection !== -1) {
    const similarContent = markdown.slice(similarSection, markdown.indexOf('### Artist FAQ') > 0 ? markdown.indexOf('### Artist FAQ') : undefined);
    const artistPattern = /\*\*(.+?)\*\*.*?\n.*?(United States|[A-Z][a-z]+(?:\s[A-Z][a-z]+)*).*?\n.*?(hip-hop\/rap|drill|r&b|pop|[a-z/-]+)/gi;
    let artistMatch;
    const seenArtists = new Set<string>();
    while ((artistMatch = artistPattern.exec(similarContent)) !== null) {
      const name = artistMatch[1].trim();
      if (!seenArtists.has(name) && seenArtists.size < 20) {
        seenArtists.add(name);
        data.similar_artists.push({
          name,
          country: artistMatch[2]?.trim() || '',
          genre: artistMatch[3]?.trim() || '',
        });
      }
    }
  }

  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY');

    if (!firecrawlKey) {
      throw new Error('FIRECRAWL_API_KEY not configured');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Determine user_id: from auth header if present, otherwise find the first profile
    let userId: string;
    const authHeader = req.headers.get('Authorization');
    if (authHeader && authHeader !== `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) throw new Error('Unauthorized');
      userId = user.id;
    } else {
      // Cron job context: find the artist's profile
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .limit(1)
        .single();
      if (profileError || !profiles) throw new Error('No profile found for cron context');
      userId = profiles.id;
    }

    console.log('[scrape-chartmetric] Scraping Chartmetric for user:', userId);

    // Call Firecrawl to scrape
    const firecrawlResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: CHARTMETRIC_URL,
        formats: ['markdown'],
        onlyMainContent: true,
      }),
    });

    const firecrawlData = await firecrawlResponse.json();
    if (!firecrawlResponse.ok) {
      console.error('[scrape-chartmetric] Firecrawl error:', firecrawlData);
      throw new Error(`Firecrawl API error: ${firecrawlData.error || firecrawlResponse.status}`);
    }

    const markdownContent = firecrawlData.data?.markdown || firecrawlData.markdown || '';
    if (!markdownContent) {
      throw new Error('No markdown content returned from Firecrawl');
    }

    console.log('[scrape-chartmetric] Got markdown, parsing...');
    const scraped = parseChartmetricMarkdown(markdownContent);
    console.log('[scrape-chartmetric] Parsed data:', JSON.stringify(scraped, null, 2));

    const now = new Date().toISOString();

    // Upsert platform data into fan_data
    const platformEntries = [
      {
        platform: 'Spotify',
        fan_identifier: 'spotify_artist_stats',
        fan_name: 'Fendi Frost',
        total_streams: scraped.monthly_listeners,
        total_interactions: scraped.spotify_followers,
        metadata: {
          monthly_listeners: scraped.monthly_listeners,
          followers: scraped.spotify_followers,
          playlist_count: scraped.playlist_count,
          playlist_reach: scraped.playlist_reach,
          top_tracks: scraped.top_tracks,
          source: 'chartmetric_scrape',
        },
      },
      {
        platform: 'Instagram',
        fan_identifier: 'instagram_stats',
        fan_name: 'Fendi Frost',
        total_interactions: scraped.ig_followers,
        metadata: { followers: scraped.ig_followers, source: 'chartmetric_scrape' },
      },
      {
        platform: 'Facebook',
        fan_identifier: 'facebook_stats',
        fan_name: 'Fendi Frost',
        total_interactions: scraped.fb_followers,
        metadata: { followers: scraped.fb_followers, source: 'chartmetric_scrape' },
      },
      {
        platform: 'X',
        fan_identifier: 'x_stats',
        fan_name: 'Fendi Frost',
        total_interactions: scraped.x_followers,
        metadata: { followers: scraped.x_followers, source: 'chartmetric_scrape' },
      },
      {
        platform: 'Shazam',
        fan_identifier: 'shazam_stats',
        fan_name: 'Fendi Frost',
        total_interactions: scraped.shazam_count,
        metadata: { shazams: scraped.shazam_count, source: 'chartmetric_scrape' },
      },
      {
        platform: 'TikTok',
        fan_identifier: 'tiktok_stats',
        fan_name: 'Fendi Frost',
        total_interactions: scraped.tiktok_post_count,
        total_streams: scraped.tiktok_top_video_views,
        metadata: {
          post_count: scraped.tiktok_post_count,
          top_video_views: scraped.tiktok_top_video_views,
          source: 'chartmetric_scrape',
        },
      },
      {
        platform: 'YouTube',
        fan_identifier: 'youtube_chartmetric_stats',
        fan_name: 'Fendi Frost',
        total_streams: scraped.youtube_most_popular_video,
        metadata: {
          most_popular_video_views: scraped.youtube_most_popular_video,
          source: 'chartmetric_scrape',
        },
      },
      {
        platform: 'Pandora',
        fan_identifier: 'pandora_stats',
        fan_name: 'Fendi Frost',
        total_streams: scraped.pandora_streams,
        total_interactions: scraped.pandora_monthly_listeners,
        metadata: {
          monthly_listeners: scraped.pandora_monthly_listeners,
          streams: scraped.pandora_streams,
          source: 'chartmetric_scrape',
        },
      },
      {
        platform: 'Chartmetric',
        fan_identifier: 'chartmetric_overview',
        fan_name: 'Fendi Frost',
        total_interactions: scraped.chartmetric_rank,
        metadata: {
          rank: scraped.chartmetric_rank,
          primary_market: scraped.primary_market,
          secondary_market: scraped.secondary_market,
          similar_artists: scraped.similar_artists,
          momentum_alerts: scraped.momentum_alerts,
          source: 'chartmetric_scrape',
        },
      },
    ];

    for (const entry of platformEntries) {
      const { data: existing } = await supabase
        .from('fan_data')
        .select('id')
        .eq('user_id', userId)
        .eq('platform', entry.platform)
        .eq('fan_identifier', entry.fan_identifier)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('fan_data')
          .update({ ...entry, last_interaction_at: now, updated_at: now })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('fan_data')
          .insert({ ...entry, user_id: userId, last_interaction_at: now });
      }
    }

    console.log('[scrape-chartmetric] Successfully stored all platform data');

    return new Response(JSON.stringify({
      success: true,
      scraped,
      updated_at: now,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[scrape-chartmetric] Error:', error);
    const statusCode = error instanceof Error && error.message === 'Unauthorized' ? 401 : 500;
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
