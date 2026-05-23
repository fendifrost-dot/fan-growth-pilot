export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      analytics_snapshots: {
        Row: {
          chartmetric_rank: number | null
          fb_followers: number | null
          id: string
          ig_followers: number | null
          metadata: Json | null
          monthly_listeners: number | null
          pandora_listeners: number | null
          playlist_count: number | null
          playlist_reach: number | null
          secondary_market: string | null
          shazams: number | null
          snapshot_at: string
          soundcloud_followers: number | null
          soundcloud_plays: number | null
          spotify_followers: number | null
          tiktok_views: number | null
          top_market: string | null
          user_id: string
          x_followers: number | null
          youtube_subscribers: number | null
          youtube_views: number | null
        }
        Insert: {
          chartmetric_rank?: number | null
          fb_followers?: number | null
          id?: string
          ig_followers?: number | null
          metadata?: Json | null
          monthly_listeners?: number | null
          pandora_listeners?: number | null
          playlist_count?: number | null
          playlist_reach?: number | null
          secondary_market?: string | null
          shazams?: number | null
          snapshot_at?: string
          soundcloud_followers?: number | null
          soundcloud_plays?: number | null
          spotify_followers?: number | null
          tiktok_views?: number | null
          top_market?: string | null
          user_id: string
          x_followers?: number | null
          youtube_subscribers?: number | null
          youtube_views?: number | null
        }
        Update: {
          chartmetric_rank?: number | null
          fb_followers?: number | null
          id?: string
          ig_followers?: number | null
          metadata?: Json | null
          monthly_listeners?: number | null
          pandora_listeners?: number | null
          playlist_count?: number | null
          playlist_reach?: number | null
          secondary_market?: string | null
          shazams?: number | null
          snapshot_at?: string
          soundcloud_followers?: number | null
          soundcloud_plays?: number | null
          spotify_followers?: number | null
          tiktok_views?: number | null
          top_market?: string | null
          user_id?: string
          x_followers?: number | null
          youtube_subscribers?: number | null
          youtube_views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_snapshots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      artist_config: {
        Row: {
          id: string
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string | null
          value: Json
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      email_campaigns: {
        Row: {
          audience_filter: Json | null
          completed_at: string | null
          created_at: string
          from_email: string
          from_name: string
          id: string
          name: string
          reply_to: string | null
          slug: string
          started_at: string | null
          status: string
          template_id: string | null
          total_failed: number
          total_sent: number
          updated_at: string
        }
        Insert: {
          audience_filter?: Json | null
          completed_at?: string | null
          created_at?: string
          from_email?: string
          from_name?: string
          id?: string
          name: string
          reply_to?: string | null
          slug: string
          started_at?: string | null
          status?: string
          template_id?: string | null
          total_failed?: number
          total_sent?: number
          updated_at?: string
        }
        Update: {
          audience_filter?: Json | null
          completed_at?: string | null
          created_at?: string
          from_email?: string
          from_name?: string
          id?: string
          name?: string
          reply_to?: string | null
          slug?: string
          started_at?: string | null
          status?: string
          template_id?: string | null
          total_failed?: number
          total_sent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      email_contacts: {
        Row: {
          created_at: string
          email: string
          engagement_score: number | null
          first_name: string | null
          id: string
          last_clicked_at: string | null
          last_name: string | null
          last_opened_at: string | null
          last_sent_at: string | null
          metadata: Json | null
          phone: string | null
          source: string | null
          subscribed: boolean
          tags: string[] | null
          unsubscribe_token: string
          unsubscribed_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          engagement_score?: number | null
          first_name?: string | null
          id?: string
          last_clicked_at?: string | null
          last_name?: string | null
          last_opened_at?: string | null
          last_sent_at?: string | null
          metadata?: Json | null
          phone?: string | null
          source?: string | null
          subscribed?: boolean
          tags?: string[] | null
          unsubscribe_token?: string
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          engagement_score?: number | null
          first_name?: string | null
          id?: string
          last_clicked_at?: string | null
          last_name?: string | null
          last_opened_at?: string | null
          last_sent_at?: string | null
          metadata?: Json | null
          phone?: string | null
          source?: string | null
          subscribed?: boolean
          tags?: string[] | null
          unsubscribe_token?: string
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      email_sends: {
        Row: {
          batch_label: string | null
          campaign_id: string | null
          contact_id: string | null
          error_message: string | null
          id: string
          metadata: Json | null
          recipient_email: string
          resend_message_id: string | null
          sent_at: string
          status: string
          test_send: boolean
        }
        Insert: {
          batch_label?: string | null
          campaign_id?: string | null
          contact_id?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          recipient_email: string
          resend_message_id?: string | null
          sent_at?: string
          status: string
          test_send?: boolean
        }
        Update: {
          batch_label?: string | null
          campaign_id?: string | null
          contact_id?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          recipient_email?: string
          resend_message_id?: string | null
          sent_at?: string
          status?: string
          test_send?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "email_sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaign_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_sends_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "email_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      email_templates: {
        Row: {
          created_at: string
          html_body: string
          id: string
          metadata: Json | null
          name: string
          preheader: string | null
          slug: string
          subject: string
          text_body: string
          updated_at: string
          variables: string[] | null
        }
        Insert: {
          created_at?: string
          html_body: string
          id?: string
          metadata?: Json | null
          name: string
          preheader?: string | null
          slug: string
          subject: string
          text_body: string
          updated_at?: string
          variables?: string[] | null
        }
        Update: {
          created_at?: string
          html_body?: string
          id?: string
          metadata?: Json | null
          name?: string
          preheader?: string | null
          slug?: string
          subject?: string
          text_body?: string
          updated_at?: string
          variables?: string[] | null
        }
        Relationships: []
      }
      fan_data: {
        Row: {
          created_at: string | null
          engagement_score: number | null
          fan_email: string | null
          fan_identifier: string | null
          fan_name: string | null
          fan_phone: string | null
          id: string
          last_interaction_at: string | null
          metadata: Json | null
          platform: string
          total_interactions: number | null
          total_streams: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          engagement_score?: number | null
          fan_email?: string | null
          fan_identifier?: string | null
          fan_name?: string | null
          fan_phone?: string | null
          id?: string
          last_interaction_at?: string | null
          metadata?: Json | null
          platform: string
          total_interactions?: number | null
          total_streams?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          engagement_score?: number | null
          fan_email?: string | null
          fan_identifier?: string | null
          fan_name?: string | null
          fan_phone?: string | null
          id?: string
          last_interaction_at?: string | null
          metadata?: Json | null
          platform?: string
          total_interactions?: number | null
          total_streams?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fan_data_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      fan_events: {
        Row: {
          campaign_id: string | null
          city: string | null
          country: string | null
          created_at: string | null
          device_type: string | null
          event_source: string | null
          event_type: string
          fan_profile_id: string | null
          id: string
          metadata: Json | null
          occurred_at: string
          song_slug: string | null
          user_id: string
          value: number | null
        }
        Insert: {
          campaign_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          device_type?: string | null
          event_source?: string | null
          event_type: string
          fan_profile_id?: string | null
          id?: string
          metadata?: Json | null
          occurred_at?: string
          song_slug?: string | null
          user_id: string
          value?: number | null
        }
        Update: {
          campaign_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          device_type?: string | null
          event_source?: string | null
          event_type?: string
          fan_profile_id?: string | null
          id?: string
          metadata?: Json | null
          occurred_at?: string
          song_slug?: string | null
          user_id?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fan_events_fan_profile_id_fkey"
            columns: ["fan_profile_id"]
            isOneToOne: false
            referencedRelation: "fan_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fan_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      fan_profiles: {
        Row: {
          city: string | null
          country: string | null
          created_at: string | null
          email: string | null
          fan_score: number
          fan_tier: string
          first_song: string | null
          first_source: string | null
          first_touch_at: string | null
          id: string
          last_touch_at: string | null
          metadata: Json | null
          phone: string | null
          region: string | null
          total_cta_clicks: number
          total_email_signups: number
          total_page_views: number
          total_purchase_value: number
          total_purchases: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string | null
          email?: string | null
          fan_score?: number
          fan_tier?: string
          first_song?: string | null
          first_source?: string | null
          first_touch_at?: string | null
          id?: string
          last_touch_at?: string | null
          metadata?: Json | null
          phone?: string | null
          region?: string | null
          total_cta_clicks?: number
          total_email_signups?: number
          total_page_views?: number
          total_purchase_value?: number
          total_purchases?: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string | null
          email?: string | null
          fan_score?: number
          fan_tier?: string
          first_song?: string | null
          first_source?: string | null
          first_touch_at?: string | null
          id?: string
          last_touch_at?: string | null
          metadata?: Json | null
          phone?: string | null
          region?: string | null
          total_cta_clicks?: number
          total_email_signups?: number
          total_page_views?: number
          total_purchase_value?: number
          total_purchases?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fan_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      follower_snapshots: {
        Row: {
          created_at: string | null
          follower_count: number
          id: string
          playlist_id: string
          snapshot_date: string
          source: string
        }
        Insert: {
          created_at?: string | null
          follower_count: number
          id?: string
          playlist_id: string
          snapshot_date?: string
          source?: string
        }
        Update: {
          created_at?: string | null
          follower_count?: number
          id?: string
          playlist_id?: string
          snapshot_date?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "follower_snapshots_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: false
            referencedRelation: "playlist_targets"
            referencedColumns: ["playlist_id"]
          },
        ]
      }
      link_analytics: {
        Row: {
          city: string | null
          clicked_at: string | null
          conversion_value: number | null
          converted: boolean | null
          country: string | null
          device_type: string | null
          id: string
          ip_address: string | null
          link_id: string
          metadata: Json | null
          referrer: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          city?: string | null
          clicked_at?: string | null
          conversion_value?: number | null
          converted?: boolean | null
          country?: string | null
          device_type?: string | null
          id?: string
          ip_address?: string | null
          link_id: string
          metadata?: Json | null
          referrer?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          city?: string | null
          clicked_at?: string | null
          conversion_value?: number | null
          converted?: boolean | null
          country?: string | null
          device_type?: string | null
          id?: string
          ip_address?: string | null
          link_id?: string
          metadata?: Json | null
          referrer?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "link_analytics_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "smart_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_analytics_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_actions: {
        Row: {
          action_payload: Json | null
          action_type: string
          created_at: string | null
          executed_at: string | null
          id: string
          priority: string
          recommendation_text: string
          related_city: string | null
          related_fan_profile_id: string | null
          related_momentum_event_id: string | null
          related_song: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          action_payload?: Json | null
          action_type: string
          created_at?: string | null
          executed_at?: string | null
          id?: string
          priority?: string
          recommendation_text: string
          related_city?: string | null
          related_fan_profile_id?: string | null
          related_momentum_event_id?: string | null
          related_song?: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          action_payload?: Json | null
          action_type?: string
          created_at?: string | null
          executed_at?: string | null
          id?: string
          priority?: string
          recommendation_text?: string
          related_city?: string | null
          related_fan_profile_id?: string | null
          related_momentum_event_id?: string | null
          related_song?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_actions_related_fan_profile_id_fkey"
            columns: ["related_fan_profile_id"]
            isOneToOne: false
            referencedRelation: "fan_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_actions_related_momentum_event_id_fkey"
            columns: ["related_momentum_event_id"]
            isOneToOne: false
            referencedRelation: "momentum_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      momentum_events: {
        Row: {
          absolute_change: number | null
          current_value: number | null
          detected_at: string
          id: string
          metadata: Json | null
          metric_name: string
          metric_source: string
          percent_change: number | null
          previous_value: number | null
          related_city: string | null
          related_song: string | null
          severity: string
          status: string
          user_id: string
        }
        Insert: {
          absolute_change?: number | null
          current_value?: number | null
          detected_at?: string
          id?: string
          metadata?: Json | null
          metric_name: string
          metric_source?: string
          percent_change?: number | null
          previous_value?: number | null
          related_city?: string | null
          related_song?: string | null
          severity?: string
          status?: string
          user_id: string
        }
        Update: {
          absolute_change?: number | null
          current_value?: number | null
          detected_at?: string
          id?: string
          metadata?: Json | null
          metric_name?: string
          metric_source?: string
          percent_change?: number | null
          previous_value?: number | null
          related_city?: string | null
          related_song?: string | null
          severity?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "momentum_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pitch_log: {
        Row: {
          cooldown_until: string | null
          created_at: string | null
          curator_email: string
          email_body: string | null
          id: string
          method: string | null
          pitched_at: string | null
          placed: boolean | null
          playlist_id: string | null
          reply_received: boolean | null
          resend_message_id: string | null
          response_notes: string | null
          sent_at: string | null
          status: string
          subject: string | null
          track_name: string
        }
        Insert: {
          cooldown_until?: string | null
          created_at?: string | null
          curator_email: string
          email_body?: string | null
          id?: string
          method?: string | null
          pitched_at?: string | null
          placed?: boolean | null
          playlist_id?: string | null
          reply_received?: boolean | null
          resend_message_id?: string | null
          response_notes?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          track_name: string
        }
        Update: {
          cooldown_until?: string | null
          created_at?: string | null
          curator_email?: string
          email_body?: string | null
          id?: string
          method?: string | null
          pitched_at?: string | null
          placed?: boolean | null
          playlist_id?: string | null
          reply_received?: boolean | null
          resend_message_id?: string | null
          response_notes?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          track_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "pitch_log_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: false
            referencedRelation: "playlist_targets"
            referencedColumns: ["playlist_id"]
          },
        ]
      }
      platform_connections: {
        Row: {
          access_token: string | null
          created_at: string | null
          id: string
          is_connected: boolean | null
          last_synced_at: string | null
          metadata: Json | null
          pixel_id: string | null
          platform: string
          platform_user_id: string | null
          profile_url: string | null
          refresh_token: string | null
          token_expires_at: string | null
          updated_at: string | null
          user_id: string
          username: string | null
        }
        Insert: {
          access_token?: string | null
          created_at?: string | null
          id?: string
          is_connected?: boolean | null
          last_synced_at?: string | null
          metadata?: Json | null
          pixel_id?: string | null
          platform: string
          platform_user_id?: string | null
          profile_url?: string | null
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id: string
          username?: string | null
        }
        Update: {
          access_token?: string | null
          created_at?: string | null
          id?: string
          is_connected?: boolean | null
          last_synced_at?: string | null
          metadata?: Json | null
          pixel_id?: string | null
          platform?: string
          platform_user_id?: string | null
          profile_url?: string | null
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_connections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      playlist_targets: {
        Row: {
          created_at: string | null
          curator_email: string | null
          curator_name: string | null
          follower_count: number | null
          fraud_score: number | null
          fraud_verdict: string | null
          id: string
          is_active: boolean | null
          last_pitched_at: string | null
          legitimacy_score: number | null
          notes: string | null
          overlap_score: number | null
          pitch_count: number
          pitch_status: string | null
          pitched_at: string | null
          platform: string
          playlist_id: string
          playlist_name: string
          research_context: Json | null
          similar_artists: Json | null
          submission_method: string | null
          submission_url: string | null
          tier: number | null
          track_count: number | null
          track_name: string
          updated_at: string | null
          vibe_tags: Json | null
          whitelist_status: boolean | null
        }
        Insert: {
          created_at?: string | null
          curator_email?: string | null
          curator_name?: string | null
          follower_count?: number | null
          fraud_score?: number | null
          fraud_verdict?: string | null
          id?: string
          is_active?: boolean | null
          last_pitched_at?: string | null
          legitimacy_score?: number | null
          notes?: string | null
          overlap_score?: number | null
          pitch_count?: number
          pitch_status?: string | null
          pitched_at?: string | null
          platform: string
          playlist_id: string
          playlist_name: string
          research_context?: Json | null
          similar_artists?: Json | null
          submission_method?: string | null
          submission_url?: string | null
          tier?: number | null
          track_count?: number | null
          track_name?: string
          updated_at?: string | null
          vibe_tags?: Json | null
          whitelist_status?: boolean | null
        }
        Update: {
          created_at?: string | null
          curator_email?: string | null
          curator_name?: string | null
          follower_count?: number | null
          fraud_score?: number | null
          fraud_verdict?: string | null
          id?: string
          is_active?: boolean | null
          last_pitched_at?: string | null
          legitimacy_score?: number | null
          notes?: string | null
          overlap_score?: number | null
          pitch_count?: number
          pitch_status?: string | null
          pitched_at?: string | null
          platform?: string
          playlist_id?: string
          playlist_name?: string
          research_context?: Json | null
          similar_artists?: Json | null
          submission_method?: string | null
          submission_url?: string | null
          tier?: number | null
          track_count?: number | null
          track_name?: string
          updated_at?: string | null
          vibe_tags?: Json | null
          whitelist_status?: boolean | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          artist_name: string | null
          avatar_url: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          id: string
          updated_at: string | null
        }
        Insert: {
          artist_name?: string | null
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string | null
        }
        Update: {
          artist_name?: string | null
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      smart_link_leads: {
        Row: {
          album_purchased: boolean | null
          album_purchased_at: string | null
          conversion_value: number | null
          converted: boolean | null
          converted_at: string | null
          created_at: string | null
          email: string
          id: string
          metadata: Json | null
          purchase_source: string | null
          shopify_order_id: string | null
          smart_link_id: string
          user_id: string | null
        }
        Insert: {
          album_purchased?: boolean | null
          album_purchased_at?: string | null
          conversion_value?: number | null
          converted?: boolean | null
          converted_at?: string | null
          created_at?: string | null
          email: string
          id?: string
          metadata?: Json | null
          purchase_source?: string | null
          shopify_order_id?: string | null
          smart_link_id: string
          user_id?: string | null
        }
        Update: {
          album_purchased?: boolean | null
          album_purchased_at?: string | null
          conversion_value?: number | null
          converted?: boolean | null
          converted_at?: string | null
          created_at?: string | null
          email?: string
          id?: string
          metadata?: Json | null
          purchase_source?: string | null
          shopify_order_id?: string | null
          smart_link_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "smart_link_leads_smart_link_id_fkey"
            columns: ["smart_link_id"]
            isOneToOne: false
            referencedRelation: "smart_links"
            referencedColumns: ["id"]
          },
        ]
      }
      smart_links: {
        Row: {
          accordion_open_count: number
          background_color: string | null
          background_image_url: string | null
          bullet_point_1: string | null
          bullet_point_2: string | null
          bullet_point_3: string | null
          button_color: string | null
          button_text: string | null
          click_count: number | null
          conversion_count: number | null
          created_at: string | null
          cta_click_count: number
          description: string | null
          destination_url: string
          email_submit_count: number
          headline: string | null
          id: string
          image_url: string | null
          is_active: boolean | null
          metadata: Json | null
          og_image_url: string | null
          short_code: string | null
          show_email_form: boolean | null
          slug: string
          subheadline: string | null
          testimonial_author: string | null
          testimonial_text: string | null
          theme_preset: string | null
          thumbnail_url: string | null
          title: string
          updated_at: string | null
          user_id: string
          video_autoplay: boolean | null
          video_play_count: number
          video_url: string | null
        }
        Insert: {
          accordion_open_count?: number
          background_color?: string | null
          background_image_url?: string | null
          bullet_point_1?: string | null
          bullet_point_2?: string | null
          bullet_point_3?: string | null
          button_color?: string | null
          button_text?: string | null
          click_count?: number | null
          conversion_count?: number | null
          created_at?: string | null
          cta_click_count?: number
          description?: string | null
          destination_url: string
          email_submit_count?: number
          headline?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          metadata?: Json | null
          og_image_url?: string | null
          short_code?: string | null
          show_email_form?: boolean | null
          slug: string
          subheadline?: string | null
          testimonial_author?: string | null
          testimonial_text?: string | null
          theme_preset?: string | null
          thumbnail_url?: string | null
          title: string
          updated_at?: string | null
          user_id: string
          video_autoplay?: boolean | null
          video_play_count?: number
          video_url?: string | null
        }
        Update: {
          accordion_open_count?: number
          background_color?: string | null
          background_image_url?: string | null
          bullet_point_1?: string | null
          bullet_point_2?: string | null
          bullet_point_3?: string | null
          button_color?: string | null
          button_text?: string | null
          click_count?: number | null
          conversion_count?: number | null
          created_at?: string | null
          cta_click_count?: number
          description?: string | null
          destination_url?: string
          email_submit_count?: number
          headline?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          metadata?: Json | null
          og_image_url?: string | null
          short_code?: string | null
          show_email_form?: boolean | null
          slug?: string
          subheadline?: string | null
          testimonial_author?: string | null
          testimonial_text?: string | null
          theme_preset?: string | null
          thumbnail_url?: string | null
          title?: string
          updated_at?: string | null
          user_id?: string
          video_autoplay?: boolean | null
          video_play_count?: number
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "smart_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      system_logs: {
        Row: {
          created_at: string | null
          duration_ms: number | null
          id: string
          message: string | null
          metadata: Json | null
          process_name: string
          status: string
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          duration_ms?: number | null
          id?: string
          message?: string | null
          metadata?: Json | null
          process_name: string
          status?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          duration_ms?: number | null
          id?: string
          message?: string | null
          metadata?: Json | null
          process_name?: string
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      email_campaign_stats: {
        Row: {
          completed_at: string | null
          created_at: string | null
          from_email: string | null
          id: string | null
          last_send_at: string | null
          name: string | null
          real_failed: number | null
          real_sent: number | null
          slug: string | null
          started_at: string | null
          status: string | null
          test_sends: number | null
          total_failed: number | null
          total_sent: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      bridge_upsert_email_contact: {
        Args: {
          p_email: string
          p_extra_tags: string[]
          p_first_name: string
          p_source: string
        }
        Returns: string
      }
      decrypt_token: { Args: { encrypted_token: string }; Returns: string }
      encrypt_token: { Args: { token: string }; Returns: string }
      generate_short_code: { Args: never; Returns: string }
      increment_accordion_open: {
        Args: { link_id: string }
        Returns: undefined
      }
      increment_cta_click: { Args: { link_id: string }; Returns: undefined }
      increment_email_submit: { Args: { link_id: string }; Returns: undefined }
      increment_link_clicks: { Args: { link_id: string }; Returns: undefined }
      increment_video_play: { Args: { link_id: string }; Returns: undefined }
      unsubscribe_by_token: {
        Args: { p_token: string }
        Returns: {
          already_unsubscribed: boolean
          email: string
        }[]
      }
      upsert_email_contacts: {
        Args: { p_rows: Json }
        Returns: {
          inserted_count: number
          skipped_count: number
          total: number
          updated_count: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
