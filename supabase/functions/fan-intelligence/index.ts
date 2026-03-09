import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── Scoring Weights (configurable in one place) ──
const SCORING_WEIGHTS = {
  page_view: 1,
  cta_click: 5,
  email_capture: 15,
  repeat_visit: 3,
  album_purchased: 30,
  repeat_purchase: 50,
  geo_detected: 1,
  campaign_touch: 2,
  smartlink_redirect: 1,
};

// ── Fan Tier Thresholds ──
function classifyTier(score: number): string {
  if (score >= 50) return 'superfan';
  if (score >= 15) return 'engaged';
  return 'casual';
}

// ── Momentum Thresholds ──
const MOMENTUM_THRESHOLDS = {
  percent_change_minor: 5,   // info
  percent_change_notable: 15, // warning
  percent_change_spike: 30,   // critical
  minimum_absolute_change: 100,
};

interface RunResult {
  fans_synced: number;
  events_backfilled: number;
  scores_updated: number;
  momentum_events_created: number;
  recommendations_created: number;
  snapshot_created: boolean;
  errors: string[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const result: RunResult = {
    fans_synced: 0,
    events_backfilled: 0,
    scores_updated: 0,
    momentum_events_created: 0,
    recommendations_created: 0,
    snapshot_created: false,
    errors: [],
  };
  let userId: string | null = null;

  try {
    // Determine user_id
    const authHeader = req.headers.get('Authorization');
    if (authHeader && authHeader !== `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) throw new Error('Unauthorized');
      userId = user.id;
    } else {
      const { data: profile, error } = await supabase.from('profiles').select('id').limit(1).single();
      if (error || !profile) throw new Error('No profile found');
      userId = profile.id;
    }

    console.log('[fan-intelligence] Running for user:', userId);

    // ════════════════════════════════════════════
    // PHASE 2: FAN IDENTITY PIPELINE
    // ════════════════════════════════════════════

    // 2a. Sync smart_link_leads → fan_profiles
    const { data: leads, error: leadsErr } = await supabase
      .from('smart_link_leads')
      .select('*, smart_links(slug, title)')
      .order('created_at', { ascending: true });

    if (leadsErr) {
      result.errors.push(`leads fetch: ${leadsErr.message}`);
    } else if (leads) {
      for (const lead of leads) {
        const email = lead.email?.toLowerCase().trim();
        if (!email) continue;

        // Check if fan_profile exists
        const { data: existing } = await supabase
          .from('fan_profiles')
          .select('id, total_purchases, total_purchase_value, total_email_signups')
          .eq('user_id', userId)
          .eq('email', email)
          .maybeSingle();

        if (existing) {
          // Update touch and purchase data
          const updates: Record<string, unknown> = { last_touch_at: new Date().toISOString() };
          if (lead.album_purchased && existing.total_purchases === 0) {
            updates.total_purchases = 1;
            updates.total_purchase_value = lead.conversion_value || 0;
          }
          await supabase.from('fan_profiles').update(updates).eq('id', existing.id);
        } else {
          // Create new fan_profile
          const songSlug = lead.smart_links?.slug || null;
          const { error: insertErr } = await supabase.from('fan_profiles').insert({
            user_id: userId,
            email,
            first_source: 'smart_link',
            first_song: songSlug,
            first_touch_at: lead.created_at,
            last_touch_at: lead.created_at,
            total_email_signups: 1,
            total_purchases: lead.album_purchased ? 1 : 0,
            total_purchase_value: lead.conversion_value || 0,
          });
          if (insertErr && !insertErr.message.includes('duplicate')) {
            result.errors.push(`fan insert ${email}: ${insertErr.message}`);
          } else {
            result.fans_synced++;
          }
        }

        // 2b. Backfill fan_events (idempotent: check if already backfilled by lead_id in metadata)
        const { data: existingEvents } = await supabase
          .from('fan_events')
          .select('id, metadata')
          .eq('user_id', userId)
          .eq('event_type', 'email_capture');

        const alreadyBackfilled = existingEvents?.some(e => {
          const md = e.metadata as Record<string, unknown> | null;
          return md?.lead_id === lead.id;
        });

        // Get fan_profile_id (needed for both email_capture and purchase backfill)
        const { data: fanProfile } = await supabase
          .from('fan_profiles')
          .select('id')
          .eq('user_id', userId)
          .eq('email', email)
          .maybeSingle();

        // Backfill email_capture event (idempotent by lead_id)
        if (!alreadyBackfilled) {
          await supabase.from('fan_events').insert({
            user_id: userId,
            fan_profile_id: fanProfile?.id || null,
            event_type: 'email_capture',
            event_source: 'smart_link',
            song_slug: lead.smart_links?.slug || null,
            occurred_at: lead.created_at,
            metadata: { lead_id: lead.id, smart_link_title: lead.smart_links?.title },
          });
          result.events_backfilled++;
        }

        // Backfill album_purchased event independently (idempotent by lead_id)
        if (lead.album_purchased && lead.album_purchased_at) {
          const { data: purchaseEvents } = await supabase
            .from('fan_events')
            .select('id, metadata')
            .eq('user_id', userId)
            .eq('event_type', 'album_purchased');

          const purchaseAlreadyLogged = purchaseEvents?.some(e => {
            const md = e.metadata as Record<string, unknown> | null;
            return md?.lead_id === lead.id;
          });

          if (!purchaseAlreadyLogged) {
            await supabase.from('fan_events').insert({
              user_id: userId,
              fan_profile_id: fanProfile?.id || null,
              event_type: 'album_purchased',
              event_source: lead.purchase_source || 'shopify',
              song_slug: lead.smart_links?.slug || null,
              value: lead.conversion_value || 0,
              occurred_at: lead.album_purchased_at,
              metadata: { lead_id: lead.id, shopify_order_id: lead.shopify_order_id },
            });
            result.events_backfilled++;
          }
        }
      }
    }

    // ════════════════════════════════════════════
    // PHASE 3: FAN SCORING ENGINE
    // ════════════════════════════════════════════

    const { data: allFans } = await supabase
      .from('fan_profiles')
      .select('id, email')
      .eq('user_id', userId);

    if (allFans) {
      for (const fan of allFans) {
        // Count events by type for this fan
        const { data: events } = await supabase
          .from('fan_events')
          .select('event_type, value')
          .eq('fan_profile_id', fan.id);

        if (!events) continue;

        let score = 0;
        const eventCounts: Record<string, number> = {};
        for (const evt of events) {
          eventCounts[evt.event_type] = (eventCounts[evt.event_type] || 0) + 1;
          const weight = SCORING_WEIGHTS[evt.event_type as keyof typeof SCORING_WEIGHTS] || 1;
          score += weight;
          // Bonus for repeat purchases
          if (evt.event_type === 'album_purchased' && eventCounts[evt.event_type] > 1) {
            score += SCORING_WEIGHTS.repeat_purchase - SCORING_WEIGHTS.album_purchased;
          }
        }

        const tier = classifyTier(score);

        await supabase
          .from('fan_profiles')
          .update({
            fan_score: score,
            fan_tier: tier,
            metadata: { event_counts: eventCounts, scoring_weights: SCORING_WEIGHTS, last_scored_at: new Date().toISOString() },
          })
          .eq('id', fan.id);

        result.scores_updated++;
      }
    }

    // ════════════════════════════════════════════
    // PHASE 4: MOMENTUM DETECTION + SNAPSHOT
    // ════════════════════════════════════════════

    // Get current platform stats from fan_data
    const { data: platformStats } = await supabase
      .from('fan_data')
      .select('*')
      .eq('user_id', userId)
      .in('fan_identifier', [
        'spotify_artist_stats', 'instagram_stats', 'facebook_stats',
        'x_stats', 'shazam_stats', 'chartmetric_overview',
        'youtube_channel_stats', 'soundcloud_user_stats',
        'tiktok_stats', 'pandora_stats',
      ]);

    const meta = (rows: typeof platformStats, identifier: string): Record<string, unknown> => {
      const row = rows?.find(r => r.fan_identifier === identifier);
      if (!row?.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) return {};
      return row.metadata as Record<string, unknown>;
    };

    const spotifyMeta = meta(platformStats || [], 'spotify_artist_stats');
    const igMeta = meta(platformStats || [], 'instagram_stats');
    const fbMeta = meta(platformStats || [], 'facebook_stats');
    const xMeta = meta(platformStats || [], 'x_stats');
    const shazamMeta = meta(platformStats || [], 'shazam_stats');
    const cmMeta = meta(platformStats || [], 'chartmetric_overview');
    const ytRow = platformStats?.find(r => r.fan_identifier === 'youtube_channel_stats');
    const scRow = platformStats?.find(r => r.fan_identifier === 'soundcloud_user_stats');
    const ttMeta = meta(platformStats || [], 'tiktok_stats');
    const pandoraMeta = meta(platformStats || [], 'pandora_stats');

    const currentMetrics = {
      monthly_listeners: (spotifyMeta.monthly_listeners as number) || 0,
      spotify_followers: (spotifyMeta.followers as number) || 0,
      playlist_count: (spotifyMeta.playlist_count as number) || 0,
      playlist_reach: (spotifyMeta.playlist_reach as number) || 0,
      ig_followers: (igMeta.followers as number) || 0,
      x_followers: (xMeta.followers as number) || 0,
      fb_followers: (fbMeta.followers as number) || 0,
      shazams: (shazamMeta.shazams as number) || 0,
      chartmetric_rank: (cmMeta.rank as number) || 0,
      youtube_subscribers: (ytRow?.total_interactions as number) || 0,
      youtube_views: (ytRow?.total_streams as number) || 0,
      soundcloud_followers: (scRow?.total_interactions as number) || 0,
      soundcloud_plays: (scRow?.total_streams as number) || 0,
      tiktok_views: (ttMeta.top_video_views as number) || 0,
      pandora_listeners: (pandoraMeta.monthly_listeners as number) || 0,
      top_market: (cmMeta.primary_market as string) || '',
      secondary_market: (cmMeta.secondary_market as string) || '',
    };

    // Create analytics snapshot
    const { error: snapErr } = await supabase.from('analytics_snapshots').insert({
      user_id: userId,
      ...currentMetrics,
    });
    result.snapshot_created = !snapErr;
    if (snapErr) result.errors.push(`snapshot: ${snapErr.message}`);

    // Compare with previous snapshot for momentum detection
    const { data: prevSnapshots } = await supabase
      .from('analytics_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('snapshot_at', { ascending: false })
      .limit(2);

    // We need the second-to-last (previous) snapshot
    const prevSnapshot = prevSnapshots && prevSnapshots.length >= 2 ? prevSnapshots[1] : null;

    if (prevSnapshot) {
      const metricsToCompare = [
        { name: 'monthly_listeners', current: currentMetrics.monthly_listeners, previous: prevSnapshot.monthly_listeners || 0 },
        { name: 'spotify_followers', current: currentMetrics.spotify_followers, previous: prevSnapshot.spotify_followers || 0 },
        { name: 'ig_followers', current: currentMetrics.ig_followers, previous: prevSnapshot.ig_followers || 0 },
        { name: 'shazams', current: currentMetrics.shazams, previous: prevSnapshot.shazams || 0 },
        { name: 'playlist_reach', current: currentMetrics.playlist_reach, previous: prevSnapshot.playlist_reach || 0 },
        { name: 'youtube_subscribers', current: currentMetrics.youtube_subscribers, previous: prevSnapshot.youtube_subscribers || 0 },
        { name: 'soundcloud_followers', current: currentMetrics.soundcloud_followers, previous: prevSnapshot.soundcloud_followers || 0 },
      ];

      for (const m of metricsToCompare) {
        if (m.previous === 0) continue; // Can't compute % change from 0
        const absoluteChange = m.current - m.previous;
        const percentChange = (absoluteChange / m.previous) * 100;

        if (Math.abs(absoluteChange) < MOMENTUM_THRESHOLDS.minimum_absolute_change) continue;
        if (Math.abs(percentChange) < MOMENTUM_THRESHOLDS.percent_change_minor) continue;

        // Check for duplicate: same metric, same day
        const today = new Date().toISOString().split('T')[0];
        const { data: existingMomentum } = await supabase
          .from('momentum_events')
          .select('id')
          .eq('user_id', userId)
          .eq('metric_name', m.name)
          .gte('detected_at', `${today}T00:00:00Z`)
          .maybeSingle();

        if (existingMomentum) continue; // Avoid noisy duplicates

        let severity = 'info';
        if (Math.abs(percentChange) >= MOMENTUM_THRESHOLDS.percent_change_spike) severity = 'critical';
        else if (Math.abs(percentChange) >= MOMENTUM_THRESHOLDS.percent_change_notable) severity = 'warning';

        const { error: momErr } = await supabase.from('momentum_events').insert({
          user_id: userId,
          metric_name: m.name,
          metric_source: 'analytics_snapshot',
          previous_value: m.previous,
          current_value: m.current,
          absolute_change: absoluteChange,
          percent_change: Math.round(percentChange * 100) / 100,
          related_city: absoluteChange > 0 ? currentMetrics.top_market : null,
          severity,
          status: 'new',
        });

        if (!momErr) result.momentum_events_created++;
        else result.errors.push(`momentum ${m.name}: ${momErr.message}`);
      }

      // Check for market changes
      if (prevSnapshot.top_market && currentMetrics.top_market && prevSnapshot.top_market !== currentMetrics.top_market) {
        await supabase.from('momentum_events').insert({
          user_id: userId,
          metric_name: 'top_market_change',
          metric_source: 'analytics_snapshot',
          previous_value: 0,
          current_value: 0,
          absolute_change: 0,
          percent_change: 0,
          related_city: currentMetrics.top_market,
          severity: 'warning',
          status: 'new',
          metadata: { previous_market: prevSnapshot.top_market, new_market: currentMetrics.top_market },
        });
        result.momentum_events_created++;
      }
    }

    // ════════════════════════════════════════════
    // PHASE 5-6: GEO INTELLIGENCE + MARKETING RECOMMENDATIONS
    // ════════════════════════════════════════════

    // Get today's new momentum events
    const today = new Date().toISOString().split('T')[0];
    const { data: todayMomentum } = await supabase
      .from('momentum_events')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'new')
      .gte('detected_at', `${today}T00:00:00Z`);

    if (todayMomentum) {
      for (const me of todayMomentum) {
        // Skip if recommendation already exists for this momentum event
        const { data: existingAction } = await supabase
          .from('marketing_actions')
          .select('id')
          .eq('related_momentum_event_id', me.id)
          .maybeSingle();

        if (existingAction) continue;

        let actionType = '';
        let recommendationText = '';
        let priority = 'medium';

        const change = me.absolute_change || 0;
        const pct = me.percent_change || 0;
        const metricLabel = me.metric_name.replace(/_/g, ' ');

        if (me.metric_name === 'top_market_change') {
          const md = (me.metadata && typeof me.metadata === 'object') ? me.metadata as Record<string, unknown> : {};
          actionType = 'geo_ad_recommendation';
          recommendationText = `Your top market shifted from ${md.previous_market || 'unknown'} to ${md.new_market || 'unknown'}. Consider geo-targeted ads in the new market.`;
          priority = 'high';
        } else if (me.severity === 'critical' && change > 0) {
          actionType = 'content_prompt';
          recommendationText = `🚀 ${metricLabel} spiked +${pct.toFixed(1)}% (${change > 0 ? '+' : ''}${change.toLocaleString()}). Create content to capitalize on this momentum.`;
          priority = 'high';
        } else if (me.severity === 'warning' && change > 0) {
          actionType = 'geo_ad_recommendation';
          recommendationText = `📈 ${metricLabel} grew +${pct.toFixed(1)}%. ${me.related_city ? `Focus on ${me.related_city} market.` : 'Consider expanding ad spend.'}`;
          priority = 'medium';
        } else if (change < 0 && me.severity !== 'info') {
          actionType = 'retargeting_recommendation';
          recommendationText = `⚠️ ${metricLabel} dropped ${pct.toFixed(1)}%. Consider retargeting campaigns to re-engage fans.`;
          priority = 'medium';
        }

        if (actionType && recommendationText) {
          await supabase.from('marketing_actions').insert({
            user_id: userId,
            action_type: actionType,
            status: 'pending',
            priority,
            related_momentum_event_id: me.id,
            related_city: me.related_city,
            recommendation_text: recommendationText,
          });
          result.recommendations_created++;
        }
      }
    }

    // Superfan recommendations
    const { data: superfans } = await supabase
      .from('fan_profiles')
      .select('id, email, fan_score, fan_tier')
      .eq('user_id', userId)
      .eq('fan_tier', 'superfan');

    if (superfans) {
      for (const sf of superfans) {
        // Check if we already recommended for this superfan recently
        const { data: existingAction } = await supabase
          .from('marketing_actions')
          .select('id')
          .eq('related_fan_profile_id', sf.id)
          .eq('action_type', 'superfan_offer')
          .gte('created_at', `${today}T00:00:00Z`)
          .maybeSingle();

        if (existingAction) continue;

        await supabase.from('marketing_actions').insert({
          user_id: userId,
          action_type: 'superfan_offer',
          status: 'pending',
          priority: 'high',
          related_fan_profile_id: sf.id,
          recommendation_text: `🌟 ${sf.email} reached superfan status (score: ${sf.fan_score}). Consider sending an exclusive offer or early access.`,
        });
        result.recommendations_created++;
      }
    }

    // Cold lead retargeting recommendation
    const { data: coldFans } = await supabase
      .from('fan_profiles')
      .select('id')
      .eq('user_id', userId)
      .eq('fan_tier', 'casual')
      .gt('total_cta_clicks', 0)
      .eq('total_purchases', 0);

    if (coldFans && coldFans.length >= 5) {
      const { data: existingColdAction } = await supabase
        .from('marketing_actions')
        .select('id')
        .eq('user_id', userId)
        .eq('action_type', 'retargeting_recommendation')
        .gte('created_at', `${today}T00:00:00Z`)
        .is('related_fan_profile_id', null)
        .maybeSingle();

      if (!existingColdAction) {
        await supabase.from('marketing_actions').insert({
          user_id: userId,
          action_type: 'retargeting_recommendation',
          status: 'pending',
          priority: 'medium',
          recommendation_text: `🎯 ${coldFans.length} fans clicked your CTA but haven't purchased. Run a retargeting campaign to convert them.`,
        });
        result.recommendations_created++;
      }
    }

    // ── Log the run ──
    const duration = Date.now() - startTime;
    await supabase.from('system_logs').insert({
      user_id: userId,
      process_name: 'fan-intelligence',
      status: result.errors.length > 0 ? 'partial' : 'success',
      message: `Synced ${result.fans_synced} fans, ${result.events_backfilled} events, ${result.scores_updated} scores, ${result.momentum_events_created} momentum, ${result.recommendations_created} actions`,
      duration_ms: duration,
      metadata: result,
    });

    console.log('[fan-intelligence] Complete:', JSON.stringify(result));

    return new Response(JSON.stringify({ success: true, ...result, duration_ms: duration }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[fan-intelligence] Fatal error:', error);

    // Log failure
    try {
      await supabase.from('system_logs').insert({
        ...(userId ? { user_id: userId } : {}),
        process_name: 'fan-intelligence',
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        duration_ms: duration,
      });
    } catch (_) { /* best effort */ }

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
