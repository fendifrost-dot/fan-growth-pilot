import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// URL-safe base64 encoding
function base64UrlEncode(data: Uint8Array): string {
  return encodeBase64(data)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
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

    // Parse body to get user_id
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const userId = body.user_id;
    if (!userId) {
      throw new Error('user_id is required');
    }

    const SOUNDCLOUD_CLIENT_ID = Deno.env.get('SOUNDCLOUD_CLIENT_ID');
    if (!SOUNDCLOUD_CLIENT_ID) {
      throw new Error('SOUNDCLOUD_CLIENT_ID not configured');
    }

    // Generate PKCE values
    const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

    // Store state and code_verifier temporarily in platform_connections (or use metadata)
    // We'll store in the metadata of an existing/new connection record
    const connectionData = {
      user_id: userId,
      platform: 'SoundCloud',
      is_connected: false,
      metadata: {
        oauth_state: state,
        code_verifier: codeVerifier,
        auth_initiated_at: new Date().toISOString(),
      },
    };

    // Upsert the connection record to store PKCE state
    const { data: existing } = await supabase
      .from('platform_connections')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', 'SoundCloud')
      .maybeSingle();

    if (existing) {
      await supabase
        .from('platform_connections')
        .update(connectionData)
        .eq('id', existing.id);
    } else {
      await supabase
        .from('platform_connections')
        .insert(connectionData);
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const redirectUri = `${SUPABASE_URL}/functions/v1/soundcloud-callback`;

    // Build SoundCloud OAuth 2.1 authorization URL
    const authUrl = new URL('https://secure.soundcloud.com/authorize');
    authUrl.searchParams.set('client_id', SOUNDCLOUD_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'non-expiring');

    return new Response(JSON.stringify({ authUrl: authUrl.toString() }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in soundcloud-auth:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
