import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const allowedOrigins = [
  'https://fan-growth-pilot.lovable.app',
  'https://4778d2a5-781c-45e5-b165-9497cdba4918.lovableproject.com',
  'http://localhost:8080', // Dev
];

const getCorsHeaders = (req: Request) => {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Credentials': 'true',
  };
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get the authorization header
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      throw new Error('Authentication required');
    }

    // Create Supabase client with the user's JWT
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Verify the authenticated user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    
    if (authError || !user) {
      console.error('Authentication failed:', authError);
      throw new Error('Authentication failed');
    }

    const { user_id } = await req.json();

    // Verify that the requested user_id matches the authenticated user
    if (user_id !== user.id) {
      console.error('User ID mismatch:', { requested: user_id, authenticated: user.id });
      throw new Error('User ID mismatch');
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

    // Create HMAC-signed state token with timestamp for CSRF protection
    const timestamp = Date.now();
    const statePayload = `${user_id}:${timestamp}`;
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(statePayload)
    );
    
    const signatureHex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    const signedState = `${statePayload}:${signatureHex}`;
    
    const spotifyAuthUrl = new URL('https://accounts.spotify.com/authorize');
    spotifyAuthUrl.searchParams.append('client_id', clientId!);
    spotifyAuthUrl.searchParams.append('response_type', 'code');
    spotifyAuthUrl.searchParams.append('redirect_uri', redirectUri);
    spotifyAuthUrl.searchParams.append('scope', scopes);
    spotifyAuthUrl.searchParams.append('state', signedState);

    console.log('Generated Spotify OAuth URL:', spotifyAuthUrl.toString());

    return new Response(JSON.stringify({ authUrl: spotifyAuthUrl.toString() }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in spotify-auth:', error);
    
    // Return generic error message, log details server-side
    const statusCode = error instanceof Error && error.message.includes('Authentication') ? 401 : 500;
    return new Response(JSON.stringify({ error: 'Authentication failed. Please try again.' }), {
      status: statusCode,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
