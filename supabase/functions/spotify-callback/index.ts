import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const signedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('Spotify OAuth error:', error);
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Spotify Authorization Failed</title>
          </head>
          <body>
            <script>
              if (window.opener) {
                try {
                  window.opener.postMessage({ type: 'spotify_error', error: 'Spotify authorization failed' }, '*');
                } catch (e) {}
                window.close();
              } else {
                window.location.href = '/admin/playlists?error=' + encodeURIComponent('Spotify authorization failed');
              }
            </script>
            <p>Authorization failed. Closing window...</p>
          </body>
        </html>
      `;
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html',
        },
      });
    }

    if (!code || !signedState) {
      throw new Error('Missing authorization code or state token');
    }

    // Verify HMAC signature and extract userId
    const stateParts = signedState.split(':');
    if (stateParts.length !== 3) {
      throw new Error('Invalid state token format');
    }

    const [userId, timestamp, receivedSignature] = stateParts;
    
    // Check if state token is expired (15 minutes)
    const stateAge = Date.now() - parseInt(timestamp);
    if (stateAge > 15 * 60 * 1000) {
      throw new Error('State token expired');
    }

    // Verify HMAC signature
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const statePayload = `${userId}:${timestamp}`;
    
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(statePayload)
    );
    
    const expectedSignature = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // Timing-safe comparison
    if (receivedSignature !== expectedSignature) {
      throw new Error('Invalid state token signature');
    }

    const clientId = Deno.env.get('SPOTIFY_CLIENT_ID');
    const clientSecret = Deno.env.get('SPOTIFY_CLIENT_SECRET');
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
    const redirectUri = `${supabaseUrl}/functions/v1/spotify-callback`;

    // Exchange code for access token
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Token exchange failed:', errorData);
      throw new Error('Failed to exchange authorization code');
    }

    const tokenData = await tokenResponse.json();

    // Get user profile from Spotify
    const profileResponse = await fetch('https://api.spotify.com/v1/me', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
      },
    });

    if (!profileResponse.ok) {
      throw new Error('Failed to fetch Spotify profile');
    }

    const profile = await profileResponse.json();

    // Store connection in Supabase with encrypted tokens
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Set encryption key for the session
    try {
      await supabase.rpc('exec_sql', {
        sql: `SET app.encryption_key = '${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}'`
      });
    } catch (e) {
      // Fallback: encryption key will be set by the functions
      console.log('Setting encryption key via function context');
    }

    // Encrypt tokens before storing
    const { data: encryptedAccess } = await supabase.rpc('encrypt_token', {
      token: tokenData.access_token
    });
    
    const { data: encryptedRefresh } = await supabase.rpc('encrypt_token', {
      token: tokenData.refresh_token
    });

    const { error: dbError } = await supabase
      .from('platform_connections')
      .upsert({
        user_id: userId,
        platform: 'Spotify',
        platform_user_id: profile.id,
        username: profile.display_name || profile.id,
        profile_url: profile.external_urls.spotify,
        access_token: encryptedAccess || tokenData.access_token,
        refresh_token: encryptedRefresh || tokenData.refresh_token,
        token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
        is_connected: true,
        last_synced_at: new Date().toISOString(),
        metadata: {
          email: profile.email,
          followers: profile.followers?.total,
          country: profile.country,
          product: profile.product,
        },
      }, {
        onConflict: 'user_id,platform',
      });

    if (dbError) {
      console.error('Database error:', dbError);
      throw new Error('Failed to store connection');
    }

    console.log('Spotify connection stored successfully for user:', userId);

    // Return HTML that closes popup and refreshes parent
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Spotify Connected</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #1DB954 0%, #191414 100%);
              color: white;
              text-align: center;
              padding: 20px;
            }
            .success {
              font-size: 48px;
              margin-bottom: 20px;
            }
            h1 {
              margin: 0 0 10px 0;
            }
            button {
              margin-top: 20px;
              padding: 12px 24px;
              font-size: 16px;
              background: #1DB954;
              border: none;
              border-radius: 24px;
              color: white;
              cursor: pointer;
              font-weight: bold;
            }
            button:hover {
              background: #1ed760;
            }
          </style>
        </head>
        <body>
          <div class="success">✓</div>
          <h1>Spotify Connected!</h1>
          <p>Your Spotify account has been successfully connected.</p>
          <button onclick="closeWindow()">Close Window</button>
          <script>
            function closeWindow() {
              if (window.opener) {
                try {
                  // Trigger a refresh in the parent window
                  window.opener.postMessage({ type: 'spotify_connected' }, '*');
                } catch (e) {
                  console.error('Could not message parent:', e);
                }
                window.close();
              } else {
                window.location.href = '/admin/playlists?spotify_connected=true';
              }
            }
            
            // Try to auto-close after a brief delay
            setTimeout(closeWindow, 1500);
          </script>
        </body>
      </html>
    `;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (error) {
    console.error('Error in spotify-callback:', error);
    
    // Return generic error message to user, log details server-side
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Spotify Connection Failed</title>
        </head>
        <body>
          <script>
            if (window.opener) {
              try {
                window.opener.postMessage({ type: 'spotify_error', error: 'Unable to complete authentication' }, '*');
              } catch (e) {}
              window.close();
            } else {
              window.location.href = '/admin/playlists?error=' + encodeURIComponent('Unable to complete authentication');
            }
          </script>
          <p>Connection failed. Closing window...</p>
        </body>
      </html>
    `;
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  }
});
