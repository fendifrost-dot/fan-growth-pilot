import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const userId = url.searchParams.get('state');
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
                window.opener.location.href = window.opener.location.href + '?error=' + encodeURIComponent('Spotify authorization failed');
                window.close();
              } else {
                window.location.href = '/?error=' + encodeURIComponent('Spotify authorization failed');
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

    if (!code || !userId) {
      throw new Error('Missing authorization code or user ID');
    }

    const clientId = Deno.env.get('SPOTIFY_CLIENT_ID');
    const clientSecret = Deno.env.get('SPOTIFY_CLIENT_SECRET');
    const redirectUri = 'https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/spotify-callback';

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

    // Store connection in Supabase
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error: dbError } = await supabase
      .from('platform_connections')
      .upsert({
        user_id: userId,
        platform: 'Spotify',
        platform_user_id: profile.id,
        username: profile.display_name || profile.id,
        profile_url: profile.external_urls.spotify,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
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
        </head>
        <body>
          <script>
            if (window.opener) {
              window.opener.location.href = window.opener.location.href + '?spotify_connected=true';
              window.close();
            } else {
              window.location.href = '/?spotify_connected=true';
            }
          </script>
          <p>Spotify connected successfully! Closing window...</p>
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
    const message = error instanceof Error ? error.message : 'Connection failed';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Spotify Connection Failed</title>
        </head>
        <body>
          <script>
            if (window.opener) {
              window.opener.location.href = window.opener.location.href + '?error=' + encodeURIComponent('${message}');
              window.close();
            } else {
              window.location.href = '/?error=' + encodeURIComponent('${message}');
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
