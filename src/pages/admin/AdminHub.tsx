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
          <h3 className="font-medium">Lyrics</h3>
          <p className="text-sm text-muted-foreground mt-1">Manual lyric upload &amp; edit (vendor deferred)</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/lyrics">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Split sheets</h3>
          <p className="text-sm text-muted-foreground mt-1">Contributor splits &amp; action items</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/split-sheets">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Sync gate</h3>
          <p className="text-sm text-muted-foreground mt-1">Fendi sample/sync approvals + ops readiness</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/sync-gate">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Private licenses</h3>
          <p className="text-sm text-muted-foreground mt-1">Evidence vault for restricted clearances</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/private-licenses">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Ops incidents</h3>
          <p className="text-sm text-muted-foreground mt-1">Log, ack, resolve operational incidents</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/ops-incidents">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Press / EPK</h3>
          <p className="text-sm text-muted-foreground mt-1">Press kit assets and bio blocks</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/press-kit">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Category coverage</h3>
          <p className="text-sm text-muted-foreground mt-1">Playlist category audit before arming sends</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/category-coverage">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Ops metrics</h3>
          <p className="text-sm text-muted-foreground mt-1">Daily discovery → verify → draft → send ledger</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/ops-metrics">Open →</Link>
          </Button>
        </Card>

        <Card className="p-5">
          <h3 className="font-medium">Song DNA</h3>
          <p className="text-sm text-muted-foreground mt-1">Approved classification, lanes, song pitch</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/song-dna">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Discovery profiles</h3>
          <p className="text-sm text-muted-foreground mt-1">Search terms, allocation, lane routing</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/discovery-profiles">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Song register</h3>
          <p className="text-sm text-muted-foreground mt-1">Titles, optional ISRC, aggregator, sample flag</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/catalogue">Open →</Link>
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="font-medium">Licensing register</h3>
          <p className="text-sm text-muted-foreground mt-1">Supervisor roster + who / when / response</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/licensing">Open →</Link>
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
          <h3 className="font-medium">Review queue</h3>
          <p className="text-sm text-muted-foreground mt-1">Verify targets before they're draftable</p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/admin/playlists/review">Open →</Link>
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
