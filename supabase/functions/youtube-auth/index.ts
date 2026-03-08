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
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Authentication required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace('Bearer ', '');
    const { data, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !data?.claims) throw new Error('Unauthorized');

    const userId = data.claims.sub as string;
    const { user_id } = await req.json();

    if (user_id !== userId) throw new Error('User ID mismatch');

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    if (!clientId) throw new Error('Google OAuth Client ID not configured');

    const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/youtube-callback`;

    // YouTube Analytics + Data API scopes for full analytics
    const scopes = [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' ');

    // HMAC-signed state for CSRF protection
    const timestamp = Date.now();
    const statePayload = `${userId}:${timestamp}`;
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(statePayload));
    const signatureHex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const signedState = `${statePayload}:${signatureHex}`;

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.append('client_id', clientId);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', scopes);
    authUrl.searchParams.append('access_type', 'offline');
    authUrl.searchParams.append('prompt', 'consent');
    authUrl.searchParams.append('state', signedState);

    return new Response(JSON.stringify({ authUrl: authUrl.toString() }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in youtube-auth:', error);
    const statusCode = error instanceof Error && error.message.includes('Unauthorized') ? 401 : 500;
    return new Response(
      JSON.stringify({ error: 'Authentication failed. Please try again.' }),
      { status: statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
