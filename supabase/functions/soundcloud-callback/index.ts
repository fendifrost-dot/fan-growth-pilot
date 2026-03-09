import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  console.log('[soundcloud-callback] ========== CALLBACK INVOKED ==========');
  console.log('[soundcloud-callback] Method:', req.method);
  console.log('[soundcloud-callback] Full URL:', req.url);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  console.log('[soundcloud-callback] code present:', !!code, 'length:', code?.length);
  console.log('[soundcloud-callback] state present:', !!state, 'value:', state);
  console.log('[soundcloud-callback] error:', error);
  console.log('[soundcloud-callback] errorDescription:', errorDescription);

  const FRONTEND_URL = Deno.env.get('FRONTEND_URL') || 'https://fan-growth-pilot.lovable.app';

  if (error) {
    console.error('[soundcloud-callback] SoundCloud OAuth error:', error, errorDescription);
    return Response.redirect(`${FRONTEND_URL}/?error=${encodeURIComponent(errorDescription || error)}`, 302);
  }

  if (!code || !state) {
    console.error('[soundcloud-callback] Missing code or state');
    return Response.redirect(`${FRONTEND_URL}/?error=Missing+code+or+state`, 302);
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Find the connection with matching state
    const { data: connections, error: connError } = await supabase
      .from('platform_connections')
      .select('*')
      .eq('platform', 'SoundCloud')
      .eq('is_connected', false);

    if (connError || !connections?.length) {
      console.error('No pending SoundCloud connections found');
      return Response.redirect(`${FRONTEND_URL}/?error=No+pending+connection`, 302);
    }

    // Find the connection with matching state in metadata
    const connection = connections.find((c: any) => {
      const meta = c.metadata as any;
      return meta?.oauth_state === state;
    });

    if (!connection) {
      console.error('State mismatch');
      return Response.redirect(`${FRONTEND_URL}/?error=State+mismatch`, 302);
    }

    const codeVerifier = (connection.metadata as any)?.code_verifier;
    if (!codeVerifier) {
      return Response.redirect(`${FRONTEND_URL}/?error=Missing+code+verifier`, 302);
    }

    const SOUNDCLOUD_CLIENT_ID = Deno.env.get('SOUNDCLOUD_CLIENT_ID');
    const SOUNDCLOUD_CLIENT_SECRET = Deno.env.get('SOUNDCLOUD_CLIENT_SECRET');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const redirectUri = `${SUPABASE_URL}/functions/v1/soundcloud-callback`;

    if (!SOUNDCLOUD_CLIENT_ID || !SOUNDCLOUD_CLIENT_SECRET) {
      return Response.redirect(`${FRONTEND_URL}/?error=SoundCloud+credentials+not+configured`, 302);
    }

    // Exchange code for token
    console.log('[soundcloud-callback] Exchanging code for token...');
    console.log('[soundcloud-callback] redirect_uri:', redirectUri);
    console.log('[soundcloud-callback] code_verifier present:', !!codeVerifier, 'length:', codeVerifier?.length);
    
    const tokenRes = await fetch('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json; charset=utf-8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: SOUNDCLOUD_CLIENT_ID,
        client_secret: SOUNDCLOUD_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code: code,
        code_verifier: codeVerifier,
      }),
    });

    console.log('[soundcloud-callback] Token response status:', tokenRes.status);
    
    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error('[soundcloud-callback] Token exchange failed:', tokenRes.status, errorText);
      return Response.redirect(`${FRONTEND_URL}/?error=Token+exchange+failed`, 302);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in;

    // Fetch user info
    const userRes = await fetch('https://api.soundcloud.com/me', {
      headers: { Authorization: `OAuth ${accessToken}` },
    });

    let scUser: any = {};
    if (userRes.ok) {
      scUser = await userRes.json();
    }

    // Update the connection with tokens and user info
    const tokenExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    await supabase
      .from('platform_connections')
      .update({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: tokenExpiry,
        is_connected: true,
        platform_user_id: scUser.id?.toString() || null,
        username: scUser.username || null,
        profile_url: scUser.permalink_url || null,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          soundcloud_id: scUser.id,
          username: scUser.username,
          full_name: scUser.full_name,
          avatar_url: scUser.avatar_url,
          followers_count: scUser.followers_count,
          followings_count: scUser.followings_count,
          track_count: scUser.track_count,
          connected_at: new Date().toISOString(),
        },
      })
      .eq('id', connection.id);

    console.log('SoundCloud connected successfully for user:', connection.user_id);
    return Response.redirect(`${FRONTEND_URL}/?soundcloud_connected=true`, 302);
  } catch (err) {
    console.error('SoundCloud callback error:', err);
    return Response.redirect(`${FRONTEND_URL}/?error=Callback+processing+failed`, 302);
  }
});
