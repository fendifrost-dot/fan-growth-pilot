import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const META_API_VERSION = 'v21.0';
const PIXEL_ID = '788829401662107';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const accessToken = Deno.env.get('META_CONVERSIONS_API_TOKEN');
  if (!accessToken) {
    console.error('META_CONVERSIONS_API_TOKEN not configured');
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const event_name = body.event_name ?? body.capi_event_name;
    const event_id = body.event_id;
    const user_data = body.user_data ?? {};
    const custom_data = body.custom_data;
    const event_source_url = body.event_source_url;
    const event_time =
      typeof body.event_time === 'number' ? body.event_time : Math.floor(Date.now() / 1000);

    if (!event_name) {
      return new Response(JSON.stringify({ error: 'event_name is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const metaUserData: Record<string, unknown> = {
      client_ip_address: user_data.client_ip_address,
      client_user_agent: user_data.client_user_agent,
      fbc: user_data.fbc,
      fbp: user_data.fbp,
    };

    if (user_data.em != null) {
      metaUserData.em = Array.isArray(user_data.em) ? user_data.em : [user_data.em];
    } else if (user_data.email && typeof user_data.email === 'string') {
      metaUserData.em = [await hashSHA256(user_data.email.toLowerCase().trim())];
    }

    if (user_data.external_id != null) {
      metaUserData.external_id = Array.isArray(user_data.external_id)
        ? user_data.external_id
        : [user_data.external_id];
    }

    const event = {
      event_name,
      event_time,
      event_id,
      event_source_url,
      action_source: body.action_source ?? 'website',
      user_data: metaUserData,
      custom_data: custom_data || {},
    };

    const url = `https://graph.facebook.com/${META_API_VERSION}/${PIXEL_ID}/events`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [event],
        access_token: accessToken,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Meta CAPI error:', JSON.stringify(result));
      return new Response(JSON.stringify({ error: 'Meta API error', details: result }), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Meta CAPI success:', JSON.stringify(result));
    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Meta CAPI exception:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function hashSHA256(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
