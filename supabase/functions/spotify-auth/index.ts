import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_id } = await req.json();

    if (!user_id) {
      throw new Error('User ID is required');
    }

    const clientId = Deno.env.get('SPOTIFY_CLIENT_ID');
    const redirectUri = 'https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/spotify-callback';

    // Spotify OAuth scopes for maximum data aggregation
    const scopes = [
      'user-read-email',
      'user-read-private',
      'user-top-read',
      'user-read-recently-played',
      'user-follow-read',
      'playlist-read-private',
      'user-library-read',
    ].join(' ');

    const spotifyAuthUrl = new URL('https://accounts.spotify.com/authorize');
    spotifyAuthUrl.searchParams.append('client_id', clientId!);
    spotifyAuthUrl.searchParams.append('response_type', 'code');
    spotifyAuthUrl.searchParams.append('redirect_uri', redirectUri);
    spotifyAuthUrl.searchParams.append('scope', scopes);
    spotifyAuthUrl.searchParams.append('state', user_id);

    console.log('Generated Spotify OAuth URL:', spotifyAuthUrl.toString());

    return new Response(JSON.stringify({ authUrl: spotifyAuthUrl.toString() }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in spotify-auth:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
