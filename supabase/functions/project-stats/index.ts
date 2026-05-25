import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const tableNames = ['smart_links', 'smart_link_leads', 'link_analytics', 'fan_data', 'platform_connections', 'profiles'];

    const counts: Record<string, number> = {};

    await Promise.all(
      tableNames.map(async (table) => {
        const { count, error } = await supabase
          .from(table)
          .select('*', { count: 'exact', head: true });
        counts[table] = error ? 0 : (count ?? 0);
      })
    );

    return new Response(
      JSON.stringify({
        project_name: 'Fan Growth Pilot',
        purpose: 'internal_healthcheck_table_counts',
        note: 'Does not refresh Spotify/Chartmetric metrics. Use refresh-platform-stats or scrape-chartmetric.',
        tables: counts,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('project-stats error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

