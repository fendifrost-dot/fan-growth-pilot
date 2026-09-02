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
    PostgrestVersion: "14.5"
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
      apple_city_spins: {
        Row: {
          area_name: string | null
          artist_id: string
          captured_at: string
          city: string | null
          country_code: string | null
          geo_id: string | null
          has_spins_data: boolean | null
          id: string
          latitude: number | null
          longitude: number | null
          metadata: Json | null
          snapshot_week: string
          spins_total: number | null
        }
        Insert: {
          area_name?: string | null
          artist_id: string
          captured_at?: string
          city?: string | null
          country_code?: string | null
          geo_id?: string | null
          has_spins_data?: boolean | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json | null
          snapshot_week: string
          spins_total?: number | null
        }
        Update: {
          area_name?: string | null
          artist_id?: string
          captured_at?: string
          city?: string | null
          country_code?: string | null
          geo_id?: string | null
          has_spins_data?: boolean | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json | null
          snapshot_week?: string
          spins_total?: number | null
        }
        Relationships: []
      }
      apple_station_plays: {
        Row: {
          area_name: string | null
          artist_id: string
          band: string | null
          captured_at: string
          city: string | null
          country_code: string | null
          frequency: string | null
          geo_id: string | null
          id: string
          latitude: number | null
          longitude: number | null
          metadata: Json | null
          period_end: string | null
          period_start: string | null
          snapshot_week: string
          song_id: string
          song_name: string | null
          spins_total: number
          station_call_sign: string | null
          station_id: string
          timezone: string | null
        }
        Insert: {
          area_name?: string | null
          artist_id: string
          band?: string | null
          captured_at?: string
          city?: string | null
          country_code?: string | null
          frequency?: string | null
          geo_id?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json | null
          period_end?: string | null
          period_start?: string | null
          snapshot_week: string
          song_id: string
          song_name?: string | null
          spins_total?: number
          station_call_sign?: string | null
          station_id: string
          timezone?: string | null
        }
        Update: {
          area_name?: string | null
          artist_id?: string
          band?: string | null
          captured_at?: string
          city?: string | null
          country_code?: string | null
          frequency?: string | null
          geo_id?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json | null
          period_end?: string | null
          period_start?: string | null
          snapshot_week?: string
          song_id?: string
          song_name?: string | null
          spins_total?: number
          station_call_sign?: string | null
          station_id?: string
          timezone?: string | null
        }
        Relationships: []
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
      categories: {
        Row: {
          created_at: string
          description: string | null
          family: string
          id: string
          label: string
          slug: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          family?: string
          id?: string
          label: string
          slug: string
        }
        Update: {
          created_at?: string
          description?: string | null
          family?: string
          id?: string
          label?: string
          slug?: string
        }
        Relationships: []
      }
      domain_blocklist: {
        Row: {
          added_at: string | null
          added_by: string | null
          domain: string
          reason: string
        }
        Insert: {
          added_at?: string | null
          added_by?: string | null
          domain: string
          reason: string
        }
        Update: {
          added_at?: string | null
          added_by?: string | null
          domain?: string
          reason?: string
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
      growth_conversations: {
        Row: {
          created_at: string
          entity_id: string
          id: string
          last_interaction_at: string | null
          opportunity_id: string | null
          resolution_class: string | null
          status: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          id?: string
          last_interaction_at?: string | null
          opportunity_id?: string | null
          resolution_class?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          id?: string
          last_interaction_at?: string | null
          opportunity_id?: string | null
          resolution_class?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "growth_conversations_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "growth_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_conversations_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "growth_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      growth_entities: {
        Row: {
          canonical_url: string | null
          created_at: string
          created_by: string | null
          description: string | null
          entity_type: string
          id: string
          location: string | null
          metadata: Json
          name: string
          parent_entity_id: string | null
          platform: string | null
          platform_external_id: string | null
          playlist_target_id: string | null
          radio_target_id: string | null
          relationship_id: string | null
          updated_at: string
        }
        Insert: {
          canonical_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          entity_type: string
          id?: string
          location?: string | null
          metadata?: Json
          name: string
          parent_entity_id?: string | null
          platform?: string | null
          platform_external_id?: string | null
          playlist_target_id?: string | null
          radio_target_id?: string | null
          relationship_id?: string | null
          updated_at?: string
        }
        Update: {
          canonical_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          entity_type?: string
          id?: string
          location?: string | null
          metadata?: Json
          name?: string
          parent_entity_id?: string | null
          platform?: string | null
          platform_external_id?: string | null
          playlist_target_id?: string | null
          radio_target_id?: string | null
          relationship_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "growth_entities_parent_entity_id_fkey"
            columns: ["parent_entity_id"]
            isOneToOne: false
            referencedRelation: "growth_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_entities_playlist_target_id_fkey"
            columns: ["playlist_target_id"]
            isOneToOne: false
            referencedRelation: "playlist_targets"
            referencedColumns: ["playlist_id"]
          },
          {
            foreignKeyName: "growth_entities_radio_target_id_fkey"
            columns: ["radio_target_id"]
            isOneToOne: false
            referencedRelation: "radio_targets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_entities_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "relationships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_entities_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "v_relationship_summary"
            referencedColumns: ["id"]
          },
        ]
      }
      growth_interactions: {
        Row: {
          body_preview: string | null
          conversation_id: string | null
          created_at: string
          direction: string
          entity_id: string | null
          external_message_id: string | null
          external_thread_ref: string | null
          id: string
          in_reply_to: string | null
          interaction_type: string
          match_status: string
          occurred_at: string
          opportunity_id: string | null
          payload: Json
          subject: string | null
        }
        Insert: {
          body_preview?: string | null
          conversation_id?: string | null
          created_at?: string
          direction?: string
          entity_id?: string | null
          external_message_id?: string | null
          external_thread_ref?: string | null
          id?: string
          in_reply_to?: string | null
          interaction_type: string
          match_status?: string
          occurred_at?: string
          opportunity_id?: string | null
          payload?: Json
          subject?: string | null
        }
        Update: {
          body_preview?: string | null
          conversation_id?: string | null
          created_at?: string
          direction?: string
          entity_id?: string | null
          external_message_id?: string | null
          external_thread_ref?: string | null
          id?: string
          in_reply_to?: string | null
          interaction_type?: string
          match_status?: string
          occurred_at?: string
          opportunity_id?: string | null
          payload?: Json
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "growth_interactions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "growth_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_interactions_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "growth_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_interactions_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "growth_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      growth_opportunities: {
        Row: {
          acted_at: string | null
          assigned_to: string | null
          audience_match_score: number | null
          conversion_probability: number | null
          created_at: string
          dedupe_key: string
          discovered_at: string
          discovery_evidence: Json
          effort_score: number | null
          entity_id: string
          generated_message: string | null
          id: string
          lifetime_value_score: number | null
          manual_score: number | null
          match_status: string
          opportunity_score: number | null
          opportunity_type: string
          override_reason: string | null
          reach_score: number | null
          recommended_action: string | null
          recommended_end_seconds: number | null
          recommended_song_id: string | null
          recommended_start_seconds: number | null
          relationship_score: number | null
          response_probability: number | null
          risk_score: number | null
          score_confidence: number | null
          score_contributions: Json
          score_overridden: boolean
          score_reason: string | null
          score_version: string | null
          scored_at: string | null
          snoozed_until: string | null
          source_platform: string | null
          source_url: string | null
          status: string
          title: string
          updated_at: string
          why_discovered: string | null
        }
        Insert: {
          acted_at?: string | null
          assigned_to?: string | null
          audience_match_score?: number | null
          conversion_probability?: number | null
          created_at?: string
          dedupe_key: string
          discovered_at?: string
          discovery_evidence?: Json
          effort_score?: number | null
          entity_id: string
          generated_message?: string | null
          id?: string
          lifetime_value_score?: number | null
          manual_score?: number | null
          match_status?: string
          opportunity_score?: number | null
          opportunity_type: string
          override_reason?: string | null
          reach_score?: number | null
          recommended_action?: string | null
          recommended_end_seconds?: number | null
          recommended_song_id?: string | null
          recommended_start_seconds?: number | null
          relationship_score?: number | null
          response_probability?: number | null
          risk_score?: number | null
          score_confidence?: number | null
          score_contributions?: Json
          score_overridden?: boolean
          score_reason?: string | null
          score_version?: string | null
          scored_at?: string | null
          snoozed_until?: string | null
          source_platform?: string | null
          source_url?: string | null
          status?: string
          title: string
          updated_at?: string
          why_discovered?: string | null
        }
        Update: {
          acted_at?: string | null
          assigned_to?: string | null
          audience_match_score?: number | null
          conversion_probability?: number | null
          created_at?: string
          dedupe_key?: string
          discovered_at?: string
          discovery_evidence?: Json
          effort_score?: number | null
          entity_id?: string
          generated_message?: string | null
          id?: string
          lifetime_value_score?: number | null
          manual_score?: number | null
          match_status?: string
          opportunity_score?: number | null
          opportunity_type?: string
          override_reason?: string | null
          reach_score?: number | null
          recommended_action?: string | null
          recommended_end_seconds?: number | null
          recommended_song_id?: string | null
          recommended_start_seconds?: number | null
          relationship_score?: number | null
          response_probability?: number | null
          risk_score?: number | null
          score_confidence?: number | null
          score_contributions?: Json
          score_overridden?: boolean
          score_reason?: string | null
          score_version?: string | null
          scored_at?: string | null
          snoozed_until?: string | null
          source_platform?: string | null
          source_url?: string | null
          status?: string
          title?: string
          updated_at?: string
          why_discovered?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "growth_opportunities_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "growth_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_opportunities_recommended_song_id_fkey"
            columns: ["recommended_song_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      growth_org_intelligence: {
        Row: {
          activity_score: number | null
          aliases: string[]
          authority_score: number | null
          blacklist_status: string | null
          created_at: string
          deliverability_score: number | null
          genre_fit_score: number | null
          genres: string[]
          historical_response_score: number | null
          id: string
          known_contact_entity_ids: string[]
          known_submission_forms: Json
          last_activity_at: string | null
          last_computed_at: string | null
          last_placement_at: string | null
          last_response_at: string | null
          notes: string | null
          org_quality_score: number | null
          organization_entity_id: string
          playlist_activity_score: number | null
          preferred_channels: string[]
          preferred_formats: string[]
          preferred_timing: Json
          relationship_score: number | null
          response_history: Json
          score_confidence: number | null
          score_contributions: Json
          score_reason: string | null
          submission_friendliness_score: number | null
          updated_at: string
        }
        Insert: {
          activity_score?: number | null
          aliases?: string[]
          authority_score?: number | null
          blacklist_status?: string | null
          created_at?: string
          deliverability_score?: number | null
          genre_fit_score?: number | null
          genres?: string[]
          historical_response_score?: number | null
          id?: string
          known_contact_entity_ids?: string[]
          known_submission_forms?: Json
          last_activity_at?: string | null
          last_computed_at?: string | null
          last_placement_at?: string | null
          last_response_at?: string | null
          notes?: string | null
          org_quality_score?: number | null
          organization_entity_id: string
          playlist_activity_score?: number | null
          preferred_channels?: string[]
          preferred_formats?: string[]
          preferred_timing?: Json
          relationship_score?: number | null
          response_history?: Json
          score_confidence?: number | null
          score_contributions?: Json
          score_reason?: string | null
          submission_friendliness_score?: number | null
          updated_at?: string
        }
        Update: {
          activity_score?: number | null
          aliases?: string[]
          authority_score?: number | null
          blacklist_status?: string | null
          created_at?: string
          deliverability_score?: number | null
          genre_fit_score?: number | null
          genres?: string[]
          historical_response_score?: number | null
          id?: string
          known_contact_entity_ids?: string[]
          known_submission_forms?: Json
          last_activity_at?: string | null
          last_computed_at?: string | null
          last_placement_at?: string | null
          last_response_at?: string | null
          notes?: string | null
          org_quality_score?: number | null
          organization_entity_id?: string
          playlist_activity_score?: number | null
          preferred_channels?: string[]
          preferred_formats?: string[]
          preferred_timing?: Json
          relationship_score?: number | null
          response_history?: Json
          score_confidence?: number | null
          score_contributions?: Json
          score_reason?: string | null
          submission_friendliness_score?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "growth_org_intelligence_organization_entity_id_fkey"
            columns: ["organization_entity_id"]
            isOneToOne: true
            referencedRelation: "growth_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      growth_relationship_events: {
        Row: {
          channel: string | null
          created_at: string
          direction: string
          entity_id: string | null
          event_type: string
          id: string
          occurred_at: string
          opportunity_id: string | null
          payload: Json
          relationship_id: string | null
          source: string | null
          source_id: string | null
          weight: number
        }
        Insert: {
          channel?: string | null
          created_at?: string
          direction?: string
          entity_id?: string | null
          event_type: string
          id?: string
          occurred_at?: string
          opportunity_id?: string | null
          payload?: Json
          relationship_id?: string | null
          source?: string | null
          source_id?: string | null
          weight?: number
        }
        Update: {
          channel?: string | null
          created_at?: string
          direction?: string
          entity_id?: string | null
          event_type?: string
          id?: string
          occurred_at?: string
          opportunity_id?: string | null
          payload?: Json
          relationship_id?: string | null
          source?: string | null
          source_id?: string | null
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "growth_relationship_events_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "growth_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_relationship_events_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "growth_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_relationship_events_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "relationships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "growth_relationship_events_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "v_relationship_summary"
            referencedColumns: ["id"]
          },
        ]
      }
      licensing_pitch_log: {
        Row: {
          company: string | null
          contact_email: string | null
          contact_name: string
          created_at: string
          id: string
          pitched_at: string
          placed: boolean
          reply_received: boolean
          response_notes: string | null
          response_status: string
          status: string
          supervisor_id: string | null
          track_id: string | null
          track_name: string
          updated_at: string
        }
        Insert: {
          company?: string | null
          contact_email?: string | null
          contact_name: string
          created_at?: string
          id?: string
          pitched_at?: string
          placed?: boolean
          reply_received?: boolean
          response_notes?: string | null
          response_status?: string
          status?: string
          supervisor_id?: string | null
          track_id?: string | null
          track_name: string
          updated_at?: string
        }
        Update: {
          company?: string | null
          contact_email?: string | null
          contact_name?: string
          created_at?: string
          id?: string
          pitched_at?: string
          placed?: boolean
          reply_received?: boolean
          response_notes?: string | null
          response_status?: string
          status?: string
          supervisor_id?: string | null
          track_id?: string | null
          track_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "licensing_pitch_log_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "music_supervisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "licensing_pitch_log_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
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
      music_supervisors: {
        Row: {
          company: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          source: string | null
          updated_at: string
        }
        Insert: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          source?: string | null
          updated_at?: string
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      non_curator_domains: {
        Row: {
          added_at: string | null
          category: string | null
          domain: string
          notes: string | null
        }
        Insert: {
          added_at?: string | null
          category?: string | null
          domain: string
          notes?: string | null
        }
        Update: {
          added_at?: string | null
          category?: string | null
          domain?: string
          notes?: string | null
        }
        Relationships: []
      }
      opportunity_actions: {
        Row: {
          action_type: string
          actor_kind: string
          actor_user_id: string | null
          channel: string | null
          created_at: string
          detail: Json
          from_status: string | null
          id: string
          message_used: string | null
          opportunity_id: string | null
          to_status: string | null
        }
        Insert: {
          action_type: string
          actor_kind?: string
          actor_user_id?: string | null
          channel?: string | null
          created_at?: string
          detail?: Json
          from_status?: string | null
          id?: string
          message_used?: string | null
          opportunity_id?: string | null
          to_status?: string | null
        }
        Update: {
          action_type?: string
          actor_kind?: string
          actor_user_id?: string | null
          channel?: string | null
          created_at?: string
          detail?: Json
          from_status?: string | null
          id?: string
          message_used?: string | null
          opportunity_id?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_actions_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "growth_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_outcomes: {
        Row: {
          conversion_value: number
          converted: boolean
          converted_at: string | null
          created_at: string
          detail: Json
          id: string
          notes: string | null
          opportunity_id: string | null
          outcome_category: string | null
          outcome_type: string
          recorded_by: string | null
          resolution_class: string | null
          responded_at: string | null
          response_received: boolean
          succeeded: boolean | null
          updated_at: string
        }
        Insert: {
          conversion_value?: number
          converted?: boolean
          converted_at?: string | null
          created_at?: string
          detail?: Json
          id?: string
          notes?: string | null
          opportunity_id?: string | null
          outcome_category?: string | null
          outcome_type: string
          recorded_by?: string | null
          resolution_class?: string | null
          responded_at?: string | null
          response_received?: boolean
          succeeded?: boolean | null
          updated_at?: string
        }
        Update: {
          conversion_value?: number
          converted?: boolean
          converted_at?: string | null
          created_at?: string
          detail?: Json
          id?: string
          notes?: string | null
          opportunity_id?: string | null
          outcome_category?: string | null
          outcome_type?: string
          recorded_by?: string | null
          resolution_class?: string | null
          responded_at?: string | null
          response_received?: boolean
          succeeded?: boolean | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_outcomes_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "growth_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      outreach_drafts: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          body: string
          campaign_id: string | null
          channel: string
          created_at: string
          env: string
          generated_at: string
          generated_by: string
          id: string
          is_test: boolean
          metadata: Json | null
          pitch_log_id: string | null
          platform: string | null
          playlist_id: string
          recipient: string | null
          sent_at: string | null
          status: string
          streaming_link: string | null
          subject: string | null
          track_id: string | null
          track_name: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          body: string
          campaign_id?: string | null
          channel: string
          created_at?: string
          env?: string
          generated_at?: string
          generated_by?: string
          id?: string
          is_test?: boolean
          metadata?: Json | null
          pitch_log_id?: string | null
          platform?: string | null
          playlist_id: string
          recipient?: string | null
          sent_at?: string | null
          status?: string
          streaming_link?: string | null
          subject?: string | null
          track_id?: string | null
          track_name: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          body?: string
          campaign_id?: string | null
          channel?: string
          created_at?: string
          env?: string
          generated_at?: string
          generated_by?: string
          id?: string
          is_test?: boolean
          metadata?: Json | null
          pitch_log_id?: string | null
          platform?: string | null
          playlist_id?: string
          recipient?: string | null
          sent_at?: string | null
          status?: string
          streaming_link?: string | null
          subject?: string | null
          track_id?: string | null
          track_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outreach_drafts_pitch_log_id_fkey"
            columns: ["pitch_log_id"]
            isOneToOne: false
            referencedRelation: "pitch_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_drafts_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: false
            referencedRelation: "playlist_targets"
            referencedColumns: ["playlist_id"]
          },
          {
            foreignKeyName: "outreach_drafts_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      pitch_log: {
        Row: {
          approval_required: boolean | null
          approved_at: string | null
          approved_by: string | null
          campaign_id: string | null
          cooldown_until: string | null
          created_at: string | null
          curator_email: string
          email_body: string | null
          follow_up_at: string | null
          id: string
          method: string | null
          pitched_at: string | null
          placed: boolean | null
          placement_status: string | null
          platform_cost_usd: number | null
          platform_name: string | null
          platform_pitch_id: string | null
          platform_pitch_url: string | null
          playlist_id: string | null
          reply_received: boolean | null
          resend_message_id: string | null
          response_notes: string | null
          sent_at: string | null
          status: string
          subject: string | null
          track_id: string | null
          track_name: string
        }
        Insert: {
          approval_required?: boolean | null
          approved_at?: string | null
          approved_by?: string | null
          campaign_id?: string | null
          cooldown_until?: string | null
          created_at?: string | null
          curator_email: string
          email_body?: string | null
          follow_up_at?: string | null
          id?: string
          method?: string | null
          pitched_at?: string | null
          placed?: boolean | null
          placement_status?: string | null
          platform_cost_usd?: number | null
          platform_name?: string | null
          platform_pitch_id?: string | null
          platform_pitch_url?: string | null
          playlist_id?: string | null
          reply_received?: boolean | null
          resend_message_id?: string | null
          response_notes?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          track_id?: string | null
          track_name: string
        }
        Update: {
          approval_required?: boolean | null
          approved_at?: string | null
          approved_by?: string | null
          campaign_id?: string | null
          cooldown_until?: string | null
          created_at?: string | null
          curator_email?: string
          email_body?: string | null
          follow_up_at?: string | null
          id?: string
          method?: string | null
          pitched_at?: string | null
          placed?: boolean | null
          placement_status?: string | null
          platform_cost_usd?: number | null
          platform_name?: string | null
          platform_pitch_id?: string | null
          platform_pitch_url?: string | null
          playlist_id?: string | null
          reply_received?: boolean | null
          resend_message_id?: string | null
          response_notes?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          track_id?: string | null
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
      playlist_categories: {
        Row: {
          category_id: string
          playlist_id: string
        }
        Insert: {
          category_id: string
          playlist_id: string
        }
        Update: {
          category_id?: string
          playlist_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "playlist_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playlist_categories_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: false
            referencedRelation: "playlist_targets"
            referencedColumns: ["playlist_id"]
          },
        ]
      }
      playlist_targets: {
        Row: {
          authenticity_notes: string | null
          authenticity_score: number | null
          bounce_count: number | null
          contact_confidence: number | null
          contact_method: string
          created_at: string | null
          curator_email: string | null
          curator_handle: string | null
          curator_instagram: string | null
          curator_linktree: string | null
          curator_name: string | null
          curator_submission_dm: string | null
          curator_submission_note: string | null
          curator_submission_url: string | null
          curator_tiktok: string | null
          curator_twitter: string | null
          curator_url: string | null
          curator_website: string | null
          follower_count: number | null
          fraud_score: number | null
          fraud_verdict: string | null
          id: string
          is_active: boolean | null
          is_paid: boolean | null
          lane: string | null
          last_bounced_at: string | null
          last_enriched_at: string | null
          last_pitched_at: string | null
          last_verified_at: string | null
          legitimacy_score: number | null
          notes: string | null
          overlap_score: number | null
          pitch_count: number
          pitch_status: string | null
          pitched_at: string | null
          platform: string
          playlist_id: string
          playlist_name: string
          recommended_pitch_angle: string | null
          research_context: Json | null
          similar_artists: Json | null
          submission_cost: string
          submission_method: string | null
          submission_url: string | null
          tier: number | null
          track_count: number | null
          track_name: string
          updated_at: string | null
          verification_notes: string | null
          verification_status: string
          vibe_tags: Json | null
          whitelist_status: boolean | null
          why_it_fits: string | null
        }
        Insert: {
          authenticity_notes?: string | null
          authenticity_score?: number | null
          bounce_count?: number | null
          contact_confidence?: number | null
          contact_method?: string
          created_at?: string | null
          curator_email?: string | null
          curator_handle?: string | null
          curator_instagram?: string | null
          curator_linktree?: string | null
          curator_name?: string | null
          curator_submission_dm?: string | null
          curator_submission_note?: string | null
          curator_submission_url?: string | null
          curator_tiktok?: string | null
          curator_twitter?: string | null
          curator_url?: string | null
          curator_website?: string | null
          follower_count?: number | null
          fraud_score?: number | null
          fraud_verdict?: string | null
          id?: string
          is_active?: boolean | null
          is_paid?: boolean | null
          lane?: string | null
          last_bounced_at?: string | null
          last_enriched_at?: string | null
          last_pitched_at?: string | null
          last_verified_at?: string | null
          legitimacy_score?: number | null
          notes?: string | null
          overlap_score?: number | null
          pitch_count?: number
          pitch_status?: string | null
          pitched_at?: string | null
          platform?: string
          playlist_id: string
          playlist_name: string
          recommended_pitch_angle?: string | null
          research_context?: Json | null
          similar_artists?: Json | null
          submission_cost?: string
          submission_method?: string | null
          submission_url?: string | null
          tier?: number | null
          track_count?: number | null
          track_name?: string
          updated_at?: string | null
          verification_notes?: string | null
          verification_status?: string
          vibe_tags?: Json | null
          whitelist_status?: boolean | null
          why_it_fits?: string | null
        }
        Update: {
          authenticity_notes?: string | null
          authenticity_score?: number | null
          bounce_count?: number | null
          contact_confidence?: number | null
          contact_method?: string
          created_at?: string | null
          curator_email?: string | null
          curator_handle?: string | null
          curator_instagram?: string | null
          curator_linktree?: string | null
          curator_name?: string | null
          curator_submission_dm?: string | null
          curator_submission_note?: string | null
          curator_submission_url?: string | null
          curator_tiktok?: string | null
          curator_twitter?: string | null
          curator_url?: string | null
          curator_website?: string | null
          follower_count?: number | null
          fraud_score?: number | null
          fraud_verdict?: string | null
          id?: string
          is_active?: boolean | null
          is_paid?: boolean | null
          lane?: string | null
          last_bounced_at?: string | null
          last_enriched_at?: string | null
          last_pitched_at?: string | null
          last_verified_at?: string | null
          legitimacy_score?: number | null
          notes?: string | null
          overlap_score?: number | null
          pitch_count?: number
          pitch_status?: string | null
          pitched_at?: string | null
          platform?: string
          playlist_id?: string
          playlist_name?: string
          recommended_pitch_angle?: string | null
          research_context?: Json | null
          similar_artists?: Json | null
          submission_cost?: string
          submission_method?: string | null
          submission_url?: string | null
          tier?: number | null
          track_count?: number | null
          track_name?: string
          updated_at?: string | null
          verification_notes?: string | null
          verification_status?: string
          vibe_tags?: Json | null
          whitelist_status?: boolean | null
          why_it_fits?: string | null
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
      radio_pitch_log: {
        Row: {
          body: string | null
          channel: string
          created_at: string | null
          id: string
          recipient: string | null
          reply_received: boolean | null
          resend_message_id: string | null
          sent_at: string | null
          song_id: string | null
          song_name: string | null
          station_call_sign: string | null
          station_id: string | null
          status: string
          subject: string | null
        }
        Insert: {
          body?: string | null
          channel?: string
          created_at?: string | null
          id?: string
          recipient?: string | null
          reply_received?: boolean | null
          resend_message_id?: string | null
          sent_at?: string | null
          song_id?: string | null
          song_name?: string | null
          station_call_sign?: string | null
          station_id?: string | null
          status?: string
          subject?: string | null
        }
        Update: {
          body?: string | null
          channel?: string
          created_at?: string | null
          id?: string
          recipient?: string | null
          reply_received?: boolean | null
          resend_message_id?: string | null
          sent_at?: string | null
          song_id?: string | null
          song_name?: string | null
          station_call_sign?: string | null
          station_id?: string | null
          status?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "radio_pitch_log_station_id_fkey"
            columns: ["station_id"]
            isOneToOne: false
            referencedRelation: "radio_targets"
            referencedColumns: ["station_id"]
          },
        ]
      }
      radio_targets: {
        Row: {
          area_name: string | null
          city: string | null
          contact_email: string | null
          contact_name: string | null
          contact_url: string | null
          country_code: string | null
          created_at: string | null
          id: string
          last_contact_at: string | null
          metadata: Json | null
          notes: string | null
          pitch_status: string
          pitched_at: string | null
          songs_played: Json | null
          station_call_sign: string
          station_id: string
          station_type: string
          submission_method: string | null
          timezone: string | null
          total_spins: number | null
          updated_at: string | null
          warmth: string
        }
        Insert: {
          area_name?: string | null
          city?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_url?: string | null
          country_code?: string | null
          created_at?: string | null
          id?: string
          last_contact_at?: string | null
          metadata?: Json | null
          notes?: string | null
          pitch_status?: string
          pitched_at?: string | null
          songs_played?: Json | null
          station_call_sign: string
          station_id: string
          station_type?: string
          submission_method?: string | null
          timezone?: string | null
          total_spins?: number | null
          updated_at?: string | null
          warmth?: string
        }
        Update: {
          area_name?: string | null
          city?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_url?: string | null
          country_code?: string | null
          created_at?: string | null
          id?: string
          last_contact_at?: string | null
          metadata?: Json | null
          notes?: string | null
          pitch_status?: string
          pitched_at?: string | null
          songs_played?: Json | null
          station_call_sign?: string
          station_id?: string
          station_type?: string
          submission_method?: string | null
          timezone?: string | null
          total_spins?: number | null
          updated_at?: string | null
          warmth?: string
        }
        Relationships: []
      }
      relationship_history: {
        Row: {
          catalog_placements: number | null
          created_at: string
          dj: string | null
          event_type: Database["public"]["Enums"]["relationship_event_type"]
          frequency: string | null
          id: string
          lifetime_value: number | null
          num_additions: number | null
          num_removals: number | null
          occurred_at: string
          payload: Json | null
          playlist_id: string | null
          playlist_name: string | null
          relationship_id: string
          show: string | null
          song: string | null
          songs_added: Json | null
          source: string
          source_id: string | null
          spins: number | null
          station_id: string | null
          territory: string | null
        }
        Insert: {
          catalog_placements?: number | null
          created_at?: string
          dj?: string | null
          event_type: Database["public"]["Enums"]["relationship_event_type"]
          frequency?: string | null
          id?: string
          lifetime_value?: number | null
          num_additions?: number | null
          num_removals?: number | null
          occurred_at?: string
          payload?: Json | null
          playlist_id?: string | null
          playlist_name?: string | null
          relationship_id: string
          show?: string | null
          song?: string | null
          songs_added?: Json | null
          source: string
          source_id?: string | null
          spins?: number | null
          station_id?: string | null
          territory?: string | null
        }
        Update: {
          catalog_placements?: number | null
          created_at?: string
          dj?: string | null
          event_type?: Database["public"]["Enums"]["relationship_event_type"]
          frequency?: string | null
          id?: string
          lifetime_value?: number | null
          num_additions?: number | null
          num_removals?: number | null
          occurred_at?: string
          payload?: Json | null
          playlist_id?: string | null
          playlist_name?: string | null
          relationship_id?: string
          show?: string | null
          song?: string | null
          songs_added?: Json | null
          source?: string
          source_id?: string | null
          spins?: number | null
          station_id?: string | null
          territory?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "relationship_history_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "relationships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationship_history_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "v_relationship_summary"
            referencedColumns: ["id"]
          },
        ]
      }
      relationship_playlists: {
        Row: {
          created_at: string
          first_discovered: string | null
          follower_count: number | null
          genre: string | null
          id: string
          is_active: boolean
          last_seen: string | null
          playlist_id: string
          playlist_name: string | null
          relationship_id: string
        }
        Insert: {
          created_at?: string
          first_discovered?: string | null
          follower_count?: number | null
          genre?: string | null
          id?: string
          is_active?: boolean
          last_seen?: string | null
          playlist_id: string
          playlist_name?: string | null
          relationship_id: string
        }
        Update: {
          created_at?: string
          first_discovered?: string | null
          follower_count?: number | null
          genre?: string | null
          id?: string
          is_active?: boolean
          last_seen?: string | null
          playlist_id?: string
          playlist_name?: string | null
          relationship_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "relationship_playlists_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: true
            referencedRelation: "playlist_targets"
            referencedColumns: ["playlist_id"]
          },
          {
            foreignKeyName: "relationship_playlists_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "relationships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationship_playlists_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "v_relationship_summary"
            referencedColumns: ["id"]
          },
        ]
      }
      relationship_shows: {
        Row: {
          created_at: string
          dj_name: string | null
          id: string
          relationship_id: string
          schedule: string | null
          show_name: string | null
          station_ref: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          dj_name?: string | null
          id?: string
          relationship_id: string
          schedule?: string | null
          show_name?: string | null
          station_ref?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          dj_name?: string | null
          id?: string
          relationship_id?: string
          schedule?: string | null
          show_name?: string | null
          station_ref?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "relationship_shows_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "relationships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationship_shows_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "v_relationship_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationship_shows_station_ref_fkey"
            columns: ["station_ref"]
            isOneToOne: false
            referencedRelation: "relationship_stations"
            referencedColumns: ["id"]
          },
        ]
      }
      relationship_stations: {
        Row: {
          area_name: string | null
          band: string | null
          call_sign: string | null
          city: string | null
          country_code: string | null
          created_at: string
          frequency: string | null
          id: string
          is_active: boolean
          relationship_id: string
          station_id: string | null
          station_type: string | null
          timezone: string | null
          total_spins: number | null
          updated_at: string
        }
        Insert: {
          area_name?: string | null
          band?: string | null
          call_sign?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          frequency?: string | null
          id?: string
          is_active?: boolean
          relationship_id: string
          station_id?: string | null
          station_type?: string | null
          timezone?: string | null
          total_spins?: number | null
          updated_at?: string
        }
        Update: {
          area_name?: string | null
          band?: string | null
          call_sign?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          frequency?: string | null
          id?: string
          is_active?: boolean
          relationship_id?: string
          station_id?: string | null
          station_type?: string | null
          timezone?: string | null
          total_spins?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "relationship_stations_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "relationships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationship_stations_relationship_id_fkey"
            columns: ["relationship_id"]
            isOneToOne: false
            referencedRelation: "v_relationship_summary"
            referencedColumns: ["id"]
          },
        ]
      }
      relationships: {
        Row: {
          audience_size: number | null
          confidence_score: number | null
          contact_form: string | null
          created_at: string
          dedupe_key: string
          email: string | null
          facebook: string | null
          genres: string[] | null
          id: string
          instagram: string | null
          is_supporter: boolean
          last_active: string | null
          last_contact: string | null
          last_reply: string | null
          linkedin: string | null
          name: string | null
          notes: string | null
          organization: string | null
          outreach_status: string
          platform: string | null
          relationship_score: number
          relationship_type: Database["public"]["Enums"]["relationship_type"]
          spotify_owner_id: string | null
          territory: string | null
          tiktok: string | null
          updated_at: string
          website: string | null
          youtube: string | null
        }
        Insert: {
          audience_size?: number | null
          confidence_score?: number | null
          contact_form?: string | null
          created_at?: string
          dedupe_key: string
          email?: string | null
          facebook?: string | null
          genres?: string[] | null
          id?: string
          instagram?: string | null
          is_supporter?: boolean
          last_active?: string | null
          last_contact?: string | null
          last_reply?: string | null
          linkedin?: string | null
          name?: string | null
          notes?: string | null
          organization?: string | null
          outreach_status?: string
          platform?: string | null
          relationship_score?: number
          relationship_type?: Database["public"]["Enums"]["relationship_type"]
          spotify_owner_id?: string | null
          territory?: string | null
          tiktok?: string | null
          updated_at?: string
          website?: string | null
          youtube?: string | null
        }
        Update: {
          audience_size?: number | null
          confidence_score?: number | null
          contact_form?: string | null
          created_at?: string
          dedupe_key?: string
          email?: string | null
          facebook?: string | null
          genres?: string[] | null
          id?: string
          instagram?: string | null
          is_supporter?: boolean
          last_active?: string | null
          last_contact?: string | null
          last_reply?: string | null
          linkedin?: string | null
          name?: string | null
          notes?: string | null
          organization?: string | null
          outreach_status?: string
          platform?: string | null
          relationship_score?: number
          relationship_type?: Database["public"]["Enums"]["relationship_type"]
          spotify_owner_id?: string | null
          territory?: string | null
          tiktok?: string | null
          updated_at?: string
          website?: string | null
          youtube?: string | null
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
      social_engagement_queue: {
        Row: {
          action: string
          approved_at: string | null
          approved_by: string | null
          created_at: string
          dm_ref: string | null
          draft_text: string | null
          id: string
          ig_handle: string | null
          operator_brief: string | null
          performed_at: string | null
          performed_by: string | null
          platform: string
          playlist_id: string | null
          result: Json | null
          status: string
          target_url: string
        }
        Insert: {
          action: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          dm_ref?: string | null
          draft_text?: string | null
          id?: string
          ig_handle?: string | null
          operator_brief?: string | null
          performed_at?: string | null
          performed_by?: string | null
          platform: string
          playlist_id?: string | null
          result?: Json | null
          status?: string
          target_url: string
        }
        Update: {
          action?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          dm_ref?: string | null
          draft_text?: string | null
          id?: string
          ig_handle?: string | null
          operator_brief?: string | null
          performed_at?: string | null
          performed_by?: string | null
          platform?: string
          playlist_id?: string | null
          result?: Json | null
          status?: string
          target_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_engagement_queue_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: false
            referencedRelation: "playlist_targets"
            referencedColumns: ["playlist_id"]
          },
        ]
      }
      song_clips: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          audio_url: string | null
          created_at: string
          created_by: string | null
          end_seconds: number
          id: string
          label: string | null
          notes: string | null
          purpose: string | null
          start_seconds: number
          status: string
          track_id: string
          transcript: string | null
          updated_at: string
          waveform_url: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          audio_url?: string | null
          created_at?: string
          created_by?: string | null
          end_seconds: number
          id?: string
          label?: string | null
          notes?: string | null
          purpose?: string | null
          start_seconds: number
          status?: string
          track_id: string
          transcript?: string | null
          updated_at?: string
          waveform_url?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          audio_url?: string | null
          created_at?: string
          created_by?: string | null
          end_seconds?: number
          id?: string
          label?: string | null
          notes?: string | null
          purpose?: string | null
          start_seconds?: number
          status?: string
          track_id?: string
          transcript?: string | null
          updated_at?: string
          waveform_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "song_clips_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      song_intelligence_profiles: {
        Row: {
          acousticness: number | null
          analysis_version: string | null
          bpm: number | null
          confidence: number | null
          created_at: string
          danceability: number | null
          energy: number | null
          genre_tags: string[]
          id: string
          instrumentalness: number | null
          mode: string | null
          mood_tags: string[]
          musical_key: string | null
          raw: Json
          similar_artists: string[]
          sonic_descriptors: string[]
          source: string | null
          summary: string | null
          track_id: string
          updated_at: string
          valence: number | null
        }
        Insert: {
          acousticness?: number | null
          analysis_version?: string | null
          bpm?: number | null
          confidence?: number | null
          created_at?: string
          danceability?: number | null
          energy?: number | null
          genre_tags?: string[]
          id?: string
          instrumentalness?: number | null
          mode?: string | null
          mood_tags?: string[]
          musical_key?: string | null
          raw?: Json
          similar_artists?: string[]
          sonic_descriptors?: string[]
          source?: string | null
          summary?: string | null
          track_id: string
          updated_at?: string
          valence?: number | null
        }
        Update: {
          acousticness?: number | null
          analysis_version?: string | null
          bpm?: number | null
          confidence?: number | null
          created_at?: string
          danceability?: number | null
          energy?: number | null
          genre_tags?: string[]
          id?: string
          instrumentalness?: number | null
          mode?: string | null
          mood_tags?: string[]
          musical_key?: string | null
          raw?: Json
          similar_artists?: string[]
          sonic_descriptors?: string[]
          source?: string | null
          summary?: string | null
          track_id?: string
          updated_at?: string
          valence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "song_intelligence_profiles_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: true
            referencedRelation: "tracks"
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
      telegram_sends: {
        Row: {
          batch_label: string | null
          campaign_id: string | null
          error_code: string | null
          error_message: string | null
          id: string
          metadata: Json | null
          recipient_chat_id: string
          sent_at: string
          status: string
          subscriber_id: string | null
          telegram_message_id: string | null
          test_send: boolean
        }
        Insert: {
          batch_label?: string | null
          campaign_id?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          recipient_chat_id: string
          sent_at?: string
          status: string
          subscriber_id?: string | null
          telegram_message_id?: string | null
          test_send?: boolean
        }
        Update: {
          batch_label?: string | null
          campaign_id?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          recipient_chat_id?: string
          sent_at?: string
          status?: string
          subscriber_id?: string | null
          telegram_message_id?: string | null
          test_send?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "telegram_sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaign_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegram_sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegram_sends_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "telegram_subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_signup_tokens: {
        Row: {
          consumed_at: string | null
          consumed_chat_id: string | null
          consumed_subscriber_id: string | null
          created_at: string
          email: string | null
          expires_at: string
          fbclid: string | null
          ip_hash: string | null
          meta_fbc: string | null
          meta_fbp: string | null
          metadata: Json | null
          smart_link_slug: string | null
          token: string
          user_agent: string | null
          utm_campaign: string | null
          utm_medium: string | null
          utm_source: string | null
        }
        Insert: {
          consumed_at?: string | null
          consumed_chat_id?: string | null
          consumed_subscriber_id?: string | null
          created_at?: string
          email?: string | null
          expires_at?: string
          fbclid?: string | null
          ip_hash?: string | null
          meta_fbc?: string | null
          meta_fbp?: string | null
          metadata?: Json | null
          smart_link_slug?: string | null
          token: string
          user_agent?: string | null
          utm_campaign?: string | null
          utm_medium?: string | null
          utm_source?: string | null
        }
        Update: {
          consumed_at?: string | null
          consumed_chat_id?: string | null
          consumed_subscriber_id?: string | null
          created_at?: string
          email?: string | null
          expires_at?: string
          fbclid?: string | null
          ip_hash?: string | null
          meta_fbc?: string | null
          meta_fbp?: string | null
          metadata?: Json | null
          smart_link_slug?: string | null
          token?: string
          user_agent?: string | null
          utm_campaign?: string | null
          utm_medium?: string | null
          utm_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telegram_signup_tokens_consumed_subscriber_id_fkey"
            columns: ["consumed_subscriber_id"]
            isOneToOne: false
            referencedRelation: "telegram_subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_subscribers: {
        Row: {
          block_count: number
          contact_id: string | null
          created_at: string
          first_name: string | null
          id: string
          language_code: string | null
          metadata: Json | null
          source_smart_link: string | null
          subscribed: boolean
          subscribed_at: string
          telegram_chat_id: string
          telegram_username: string | null
          unsubscribed_at: string | null
          updated_at: string
        }
        Insert: {
          block_count?: number
          contact_id?: string | null
          created_at?: string
          first_name?: string | null
          id?: string
          language_code?: string | null
          metadata?: Json | null
          source_smart_link?: string | null
          subscribed?: boolean
          subscribed_at?: string
          telegram_chat_id: string
          telegram_username?: string | null
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Update: {
          block_count?: number
          contact_id?: string | null
          created_at?: string
          first_name?: string | null
          id?: string
          language_code?: string | null
          metadata?: Json | null
          source_smart_link?: string | null
          subscribed?: boolean
          subscribed_at?: string
          telegram_chat_id?: string
          telegram_username?: string | null
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telegram_subscribers_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "email_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_webhook_processed_updates: {
        Row: {
          received_at: string
          update_id: number
        }
        Insert: {
          received_at?: string
          update_id: number
        }
        Update: {
          received_at?: string
          update_id?: number
        }
        Relationships: []
      }
      track_categories: {
        Row: {
          category_id: string
          track_id: string
        }
        Insert: {
          category_id: string
          track_id: string
        }
        Update: {
          category_id?: string
          track_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "track_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_categories_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      song_dna_versions: {
        Row: {
          id: string
          track_id: string
          version_number: number
          approval_state: string
          primary_genre: string | null
          secondary_genres: string[]
          approved_lanes: string[]
          excluded_lanes: string[]
          mood_tags: string[]
          bpm_hint: number | null
          energy_hint: number | null
          sample_declaration: string
          sync_recommendation: string
          notes: string | null
          payload: Json
          created_by: string | null
          submitted_at: string | null
          approved_by: string | null
          approved_at: string | null
          rejected_by: string | null
          rejected_at: string | null
          rejection_reason: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          track_id: string
          version_number: number
          approval_state?: string
          primary_genre?: string | null
          secondary_genres?: string[]
          approved_lanes?: string[]
          excluded_lanes?: string[]
          mood_tags?: string[]
          bpm_hint?: number | null
          energy_hint?: number | null
          sample_declaration?: string
          sync_recommendation?: string
          notes?: string | null
          payload?: Json
          created_by?: string | null
          submitted_at?: string | null
          approved_by?: string | null
          approved_at?: string | null
          rejected_by?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          track_id?: string
          version_number?: number
          approval_state?: string
          primary_genre?: string | null
          secondary_genres?: string[]
          approved_lanes?: string[]
          excluded_lanes?: string[]
          mood_tags?: string[]
          bpm_hint?: number | null
          energy_hint?: number | null
          sample_declaration?: string
          sync_recommendation?: string
          notes?: string | null
          payload?: Json
          created_by?: string | null
          submitted_at?: string | null
          approved_by?: string | null
          approved_at?: string | null
          rejected_by?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "song_dna_versions_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      song_dna_audit_events: {
        Row: {
          id: string
          song_dna_version_id: string
          track_id: string
          event_type: string
          actor_user_id: string | null
          actor_kind: string | null
          from_state: string | null
          to_state: string | null
          detail: Json
          created_at: string
        }
        Insert: {
          id?: string
          song_dna_version_id: string
          track_id: string
          event_type: string
          actor_user_id?: string | null
          actor_kind?: string | null
          from_state?: string | null
          to_state?: string | null
          detail?: Json
          created_at?: string
        }
        Update: {
          id?: string
          song_dna_version_id?: string
          track_id?: string
          event_type?: string
          actor_user_id?: string | null
          actor_kind?: string | null
          from_state?: string | null
          to_state?: string | null
          detail?: Json
          created_at?: string
        }
        Relationships: []
      }
      private_license_evidence: {
        Row: {
          id: string
          track_id: string
          label: string
          storage_path: string | null
          notes: string | null
          uploaded_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          track_id: string
          label: string
          storage_path?: string | null
          notes?: string | null
          uploaded_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          track_id?: string
          label?: string
          storage_path?: string | null
          notes?: string | null
          uploaded_by?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "private_license_evidence_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_incidents: {
        Row: {
          id: string
          severity: string
          category: string
          title: string
          detail: Json
          track_id: string | null
          campaign_id: string | null
          related_entity: string | null
          related_id: string | null
          status: string
          created_by: string | null
          acknowledged_by: string | null
          resolved_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          severity?: string
          category?: string
          title: string
          detail?: Json
          track_id?: string | null
          campaign_id?: string | null
          related_entity?: string | null
          related_id?: string | null
          status?: string
          created_by?: string | null
          acknowledged_by?: string | null
          resolved_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          severity?: string
          category?: string
          title?: string
          detail?: Json
          track_id?: string | null
          campaign_id?: string | null
          related_entity?: string | null
          related_id?: string | null
          status?: string
          created_by?: string | null
          acknowledged_by?: string | null
          resolved_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      press_kits: {
        Row: {
          id: string
          slug: string
          title: string
          status: string
          one_liner: string | null
          bio_short: string | null
          bio_long: string | null
          press_email: string | null
          assets: Json
          links: Json
          notes: string | null
          published_at: string | null
          created_by: string | null
          updated_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          slug: string
          title: string
          status?: string
          one_liner?: string | null
          bio_short?: string | null
          bio_long?: string | null
          press_email?: string | null
          assets?: Json
          links?: Json
          notes?: string | null
          published_at?: string | null
          created_by?: string | null
          updated_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          slug?: string
          title?: string
          status?: string
          one_liner?: string | null
          bio_short?: string | null
          bio_long?: string | null
          press_email?: string | null
          assets?: Json
          links?: Json
          notes?: string | null
          published_at?: string | null
          created_by?: string | null
          updated_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      tracks: {
        Row: {
          aggregator: string
          apple_music_url: string | null
          created_at: string
          default_tone: string
          duration_seconds: number | null
          eligibility_reason: string | null
          eligibility_set_at: string | null
          eligibility_set_by: string | null
          eligibility_si_version: string | null
          eligibility_source: string | null
          genre_stamp: string
          has_sample: string
          id: string
          is_month1_sync_default: boolean
          isrc: string | null
          name: string
          notes: string | null
          outreach_eligibility: Database["public"]["Enums"]["outreach_eligibility"]
          pitch_angle: string | null
          reference_artists: string[]
          release_date: string | null
          short_pitch: string | null
          soundcloud_url: string | null
          spotify_url: string | null
          status: string
          approved_song_dna_version_id: string | null
          sample_declaration_approved_at: string | null
          sample_declaration_approved_by: string | null
          sync_approved_at: string | null
          sync_approved_by: string | null
          splits_ready: boolean
          publishing_ready: boolean
          assets_ready: boolean
          unresolved_rights_exception: boolean
          sample_exception_resolved: boolean
          sync_eligible: boolean | null
          sync_eligible_blockers: string[]
          sync_eligible_computed_at: string | null
          updated_at: string
        }
        Insert: {
          aggregator?: string
          apple_music_url?: string | null
          created_at?: string
          default_tone?: string
          duration_seconds?: number | null
          eligibility_reason?: string | null
          eligibility_set_at?: string | null
          eligibility_set_by?: string | null
          eligibility_si_version?: string | null
          eligibility_source?: string | null
          genre_stamp?: string
          has_sample?: string
          id?: string
          is_month1_sync_default?: boolean
          isrc?: string | null
          name: string
          notes?: string | null
          outreach_eligibility?: Database["public"]["Enums"]["outreach_eligibility"]
          pitch_angle?: string | null
          reference_artists?: string[]
          release_date?: string | null
          short_pitch?: string | null
          soundcloud_url?: string | null
          spotify_url?: string | null
          status?: string
          approved_song_dna_version_id?: string | null
          sample_declaration_approved_at?: string | null
          sample_declaration_approved_by?: string | null
          sync_approved_at?: string | null
          sync_approved_by?: string | null
          splits_ready?: boolean
          publishing_ready?: boolean
          assets_ready?: boolean
          unresolved_rights_exception?: boolean
          sample_exception_resolved?: boolean
          sync_eligible?: boolean | null
          sync_eligible_blockers?: string[]
          sync_eligible_computed_at?: string | null
          updated_at?: string
        }
        Update: {
          aggregator?: string
          apple_music_url?: string | null
          created_at?: string
          default_tone?: string
          duration_seconds?: number | null
          eligibility_reason?: string | null
          eligibility_set_at?: string | null
          eligibility_set_by?: string | null
          eligibility_si_version?: string | null
          eligibility_source?: string | null
          genre_stamp?: string
          has_sample?: string
          id?: string
          is_month1_sync_default?: boolean
          isrc?: string | null
          name?: string
          notes?: string | null
          outreach_eligibility?: Database["public"]["Enums"]["outreach_eligibility"]
          pitch_angle?: string | null
          reference_artists?: string[]
          release_date?: string | null
          short_pitch?: string | null
          soundcloud_url?: string | null
          spotify_url?: string | null
          status?: string
          approved_song_dna_version_id?: string | null
          sample_declaration_approved_at?: string | null
          sample_declaration_approved_by?: string | null
          sync_approved_at?: string | null
          sync_approved_by?: string | null
          splits_ready?: boolean
          publishing_ready?: boolean
          assets_ready?: boolean
          unresolved_rights_exception?: boolean
          sample_exception_resolved?: boolean
          sync_eligible?: boolean | null
          sync_eligible_blockers?: string[]
          sync_eligible_computed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          granted_at: string
          granted_by: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
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
      telegram_campaign_send_summary: {
        Row: {
          blocked_count: number | null
          campaign_id: string | null
          failed_count: number | null
          first_attempt_at: string | null
          last_attempt_at: string | null
          sent_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "telegram_sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaign_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegram_sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_inner_circle_stats: {
        Row: {
          blocks_30d: number | null
          sends_failed_30d: number | null
          sends_succeeded_30d: number | null
          subscribers_active: number | null
          subscribers_added_30d: number | null
          subscribers_added_7d: number | null
        }
        Relationships: []
      }
      telegram_subscribers_by_source: {
        Row: {
          active_subscribers: number | null
          source_smart_link: string | null
          total: number | null
          unsubscribed: number | null
        }
        Relationships: []
      }
      v_relationship_summary: {
        Row: {
          audience_size: number | null
          confidence_score: number | null
          created_at: string | null
          email: string | null
          genres: string[] | null
          id: string | null
          instagram: string | null
          is_supporter: boolean | null
          last_active: string | null
          last_contact: string | null
          last_reply: string | null
          name: string | null
          organization: string | null
          outreach_status: string | null
          placement_count: number | null
          platform: string | null
          playlist_count: number | null
          relationship_score: number | null
          relationship_type:
            | Database["public"]["Enums"]["relationship_type"]
            | null
          territory: string | null
          updated_at: string | null
          website: string | null
        }
        Insert: {
          audience_size?: number | null
          confidence_score?: number | null
          created_at?: string | null
          email?: string | null
          genres?: string[] | null
          id?: string | null
          instagram?: string | null
          is_supporter?: boolean | null
          last_active?: string | null
          last_contact?: string | null
          last_reply?: string | null
          name?: string | null
          organization?: string | null
          outreach_status?: string | null
          placement_count?: never
          platform?: string | null
          playlist_count?: never
          relationship_score?: number | null
          relationship_type?:
            | Database["public"]["Enums"]["relationship_type"]
            | null
          territory?: string | null
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          audience_size?: number | null
          confidence_score?: number | null
          created_at?: string | null
          email?: string | null
          genres?: string[] | null
          id?: string | null
          instagram?: string | null
          is_supporter?: boolean | null
          last_active?: string | null
          last_contact?: string | null
          last_reply?: string | null
          name?: string | null
          organization?: string | null
          outreach_status?: string | null
          placement_count?: never
          platform?: string | null
          playlist_count?: never
          relationship_score?: number | null
          relationship_type?:
            | Database["public"]["Enums"]["relationship_type"]
            | null
          territory?: string | null
          updated_at?: string | null
          website?: string | null
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
      growth_opportunity_transition_allowed: {
        Args: { new_status: string; old_status: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_accordion_open: {
        Args: { link_id: string }
        Returns: undefined
      }
      increment_cta_click: { Args: { link_id: string }; Returns: undefined }
      increment_email_submit: { Args: { link_id: string }; Returns: undefined }
      increment_link_clicks: { Args: { link_id: string }; Returns: undefined }
      increment_video_play: { Args: { link_id: string }; Returns: undefined }
      rie_recompute_scores: { Args: never; Returns: number }
      rie_relationship_score: {
        Args: {
          p_audience: number
          p_confidence: number
          p_genre_match: number
          p_last_active: string
          p_placements: number
          p_replies: number
          p_retention: number
        }
        Returns: number
      }
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
      app_role: "admin" | "operator"
      outreach_eligibility:
        | "eligible"
        | "needs_song_intelligence"
        | "no_genre_lane"
        | "blocked"
      relationship_event_type:
        | "discovered"
        | "playlist_add"
        | "playlist_remove"
        | "pitch_sent"
        | "reply"
        | "placement"
        | "spin"
        | "follower_snapshot"
        | "mention"
      relationship_type:
        | "spotify_curator"
        | "apple_radio_station"
        | "radio_dj"
        | "college_radio"
        | "terrestrial_radio"
        | "internet_radio"
        | "blog"
        | "press"
        | "youtube"
        | "tiktok"
        | "instagram"
        | "twitch"
        | "podcast"
        | "other"
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
    Enums: {
      app_role: ["admin", "operator"],
      outreach_eligibility: [
        "eligible",
        "needs_song_intelligence",
        "no_genre_lane",
        "blocked",
      ],
      relationship_event_type: [
        "discovered",
        "playlist_add",
        "playlist_remove",
        "pitch_sent",
        "reply",
        "placement",
        "spin",
        "follower_snapshot",
        "mention",
      ],
      relationship_type: [
        "spotify_curator",
        "apple_radio_station",
        "radio_dj",
        "college_radio",
        "terrestrial_radio",
        "internet_radio",
        "blog",
        "press",
        "youtube",
        "tiktok",
        "instagram",
        "twitch",
        "podcast",
        "other",
      ],
    },
  },
} as const
