import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { callHubFn } from "@/lib/hubApi";

type OutreachStats = {
  fan_email_subscribers: number;
  fan_telegram_subscribers: number;
  playlist_pending_drafts: number;
  playlist_emails_24h: number;
  radio_stations: number;
  radio_with_email: number;
  instagram_dm_queue: number;
  ig_roster_mutual?: number;
  ig_roster_total?: number;
};

const AdminHub: React.FC = () => {
  const [stats, setStats] = useState<OutreachStats | null>(null);

  useEffect(() => {
    callHubFn<OutreachStats>("get_outreach_stats", {}).then(setStats).catch(() => setStats(null));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Command center</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Start at <strong>Send</strong> for every outbound channel — fan email, Telegram, playlist, radio, and IG.
        </p>
      </div>

      <Card className="p-6 border-primary/30 bg-primary/5">
        <h2 className="text-lg font-medium">Send center — all channels</h2>
        <p className="text-sm text-muted-foreground mt-2">
          One UI for subscriber blasts, curator pitches, radio thank-yous, and manual IG DMs.
        </p>
        {stats && (
          <ul className="text-sm mt-4 space-y-1 text-muted-foreground">
            <li>Fan email: {stats.fan_email_subscribers} subscribers</li>
            <li>Fan Telegram: {stats.fan_telegram_subscribers} subscribers</li>
            <li>Playlist: {stats.playlist_pending_drafts} pending drafts · {stats.playlist_emails_24h} emails (24h)</li>
            <li>Radio: {stats.radio_with_email}/{stats.radio_stations} stations with email</li>
            <li>Instagram: {stats.instagram_dm_queue} DMs queued · {stats.ig_roster_mutual ?? 0} mutual on roster</li>
          </ul>
        )}
        <Button className="mt-4" asChild>
          <Link to="/admin/send">Open Send center →</Link>
        </Button>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5">
          <h3 className="font-medium">Pitch Composer</h3>
          <p className="text-sm text-muted-foreground mt-1">Multi-tone drafts with warm/cold detection</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/pitch-composer">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Song catalogue</h3>
          <p className="text-sm text-muted-foreground mt-1">Tracks, tones, and category tags</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/catalogue">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Find playlists</h3>
          <p className="text-sm text-muted-foreground mt-1">Research → enrich → draft curator emails</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/playlists">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Curator drafts</h3>
          <p className="text-sm text-muted-foreground mt-1">Full editor for approve &amp; send</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/outreach">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Email campaigns</h3>
          <p className="text-sm text-muted-foreground mt-1">Fan list batch sends (Resend)</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/campaigns">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">IG roster (mutual)</h3>
          <p className="text-sm text-muted-foreground mt-1">Verify follow-back before queuing DMs</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/ig-roster">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Radio targets</h3>
          <p className="text-sm text-muted-foreground mt-1">37 warm stations · patch emails · send</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/radio">Open →</Link>
          </Button>
        </Card>
      </div>
    </div>
  );
};

export default AdminHub;
