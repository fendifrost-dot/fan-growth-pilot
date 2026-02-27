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
    const { event_name, event_id, user_data, custom_data, event_source_url } = body;

    if (!event_name) {
      return new Response(JSON.stringify({ error: 'event_name is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build the event payload per Meta CAPI spec
    const event = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id, // Matches the client-side eventID for deduplication
      event_source_url,
      action_source: 'website',
      user_data: {
        // Hash PII fields with SHA-256 if provided
        ...(user_data?.email && { em: await hashSHA256(user_data.email.toLowerCase().trim()) }),
        client_ip_address: user_data?.client_ip_address,
        client_user_agent: user_data?.client_user_agent,
        fbc: user_data?.fbc, // Facebook click ID cookie
        fbp: user_data?.fbp, // Facebook browser ID cookie
      },
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
