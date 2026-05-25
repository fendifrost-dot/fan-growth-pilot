/**
 * Internal-only: chains scrape-chartmetric → fan-intelligence for scheduled refresh.
 * Invoke via Supabase Edge Function schedule or pg_cron + x-stats-cron-secret.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-stats-cron-secret, x-api-key',
};

function authorizeCron(req: Request): boolean {
  const cronSecret = (Deno.env.get('STATS_CRON_SECRET') || '').trim();
  const provided = (req.headers.get('x-stats-cron-secret') || '').trim();
  if (cronSecret && provided === cronSecret) return true;

  const hubKey = (Deno.env.get('FANFUEL_HUB_KEY') || '').trim();
  const xApi = (req.headers.get('x-api-key') || '').trim();
  if (hubKey && xApi === hubKey) return true;

  const auth = req.headers.get('Authorization') || '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!auth || auth === `Bearer ${anon}`) return true;

  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (!authorizeCron(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const baseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const cronSecret = Deno.env.get('STATS_CRON_SECRET') || '';

  if (!baseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Missing Supabase env' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const invokeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
  };
  if (cronSecret) invokeHeaders['x-stats-cron-secret'] = cronSecret;

  const steps: { name: string; ok: boolean; status: number; detail?: string }[] = [];

  try {
    const scrapeRes = await fetch(`${baseUrl}/functions/v1/scrape-chartmetric`, {
      method: 'POST',
      headers: invokeHeaders,
      body: '{}',
    });
    const scrapeBody = await scrapeRes.text();
    steps.push({
      name: 'scrape-chartmetric',
      ok: scrapeRes.ok,
      status: scrapeRes.status,
      detail: scrapeRes.ok ? undefined : scrapeBody.slice(0, 500),
    });
    if (!scrapeRes.ok) {
      return new Response(JSON.stringify({ ok: false, steps }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const fiRes = await fetch(`${baseUrl}/functions/v1/fan-intelligence`, {
      method: 'POST',
      headers: invokeHeaders,
      body: '{}',
    });
    const fiBody = await fiRes.text();
    steps.push({
      name: 'fan-intelligence',
      ok: fiRes.ok,
      status: fiRes.status,
      detail: fiRes.ok ? undefined : fiBody.slice(0, 500),
    });

    let fanIntelligence: unknown = null;
    if (fiRes.ok) {
      try {
        fanIntelligence = JSON.parse(fiBody);
      } catch {
        fanIntelligence = { raw: fiBody.slice(0, 200) };
      }
    }

    return new Response(
      JSON.stringify({
        ok: fiRes.ok,
        refreshed_at: new Date().toISOString(),
        steps,
        fan_intelligence: fanIntelligence,
      }),
      {
        status: fiRes.ok ? 200 : 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    console.error('[refresh-platform-stats]', error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        steps,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
