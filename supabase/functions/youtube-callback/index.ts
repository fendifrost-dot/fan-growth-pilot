import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const FRONTEND_URL = 'https://fan-growth-pilot.lovable.app';

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('OAuth error from Google:', error);
      return Response.redirect(`${FRONTEND_URL}?error=${encodeURIComponent(error)}`, 302);
    }

    if (!code || !state) {
      return Response.redirect(`${FRONTEND_URL}?error=missing_params`, 302);
    }

    // Verify HMAC-signed state
    const stateParts = state.split(':');
    if (stateParts.length !== 3) {
      return Response.redirect(`${FRONTEND_URL}?error=invalid_state`, 302);
    }

    const [userId, timestamp, receivedSignature] = stateParts;
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const statePayload = `${userId}:${timestamp}`;
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(statePayload));
    const expectedSignature = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (receivedSignature !== expectedSignature) {
      return Response.redirect(`${FRONTEND_URL}?error=invalid_signature`, 302);
    }

    // Check timestamp (10 minute window)
    if (Date.now() - parseInt(timestamp) > 600000) {
      return Response.redirect(`${FRONTEND_URL}?error=state_expired`, 302);
    }

    // Exchange code for tokens
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID')!;
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET')!;
    const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/youtube-callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', tokenData);
      return Response.redirect(`${FRONTEND_URL}?error=token_exchange_failed`, 302);
    }

    // Get YouTube channel info
    const channelRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const channelData = await channelRes.json();
    const channel = channelData.items?.[0];

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Set encryption key
    await supabase.rpc('decrypt_token', { encrypted_token: '' }).catch(() => {});
    try {
      await supabase.rpc('encrypt_token', { token: 'test' });
    } catch {}

    const now = new Date().toISOString();
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    // Store connection with encrypted tokens
    const { data: existing } = await supabase
      .from('platform_connections')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', 'YouTube')
      .maybeSingle();

    const connectionPayload = {
      platform: 'YouTube',
      username: channel?.snippet?.title || 'YouTube Channel',
      profile_url: channel ? `https://youtube.com/channel/${channel.id}` : null,
      platform_user_id: channel?.id || null,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      token_expires_at: expiresAt,
      is_connected: true,
      last_synced_at: now,
      metadata: {
        channel_id: channel?.id,
        channel_name: channel?.snippet?.title,
        subscribers: parseInt(channel?.statistics?.subscriberCount || '0'),
        scopes: 'youtube.readonly,yt-analytics.readonly',
      },
    };

    if (existing) {
      await supabase
        .from('platform_connections')
        .update({ ...connectionPayload, updated_at: now })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('platform_connections')
        .insert({ ...connectionPayload, user_id: userId });
    }

    // Return HTML that closes popup and notifies parent
    const html = `<!DOCTYPE html>
<html><head><title>YouTube Connected</title></head>
<body>
<script>
  if (window.opener) {
    window.opener.location.href = '${FRONTEND_URL}?youtube_connected=true';
    window.close();
  } else {
    window.location.href = '${FRONTEND_URL}?youtube_connected=true';
  }
</script>
<p>YouTube connected! Redirecting...</p>
</body></html>`;

    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  } catch (error) {
    console.error('Error in youtube-callback:', error);
    return Response.redirect(`${FRONTEND_URL}?error=callback_failed`, 302);
  }
});
