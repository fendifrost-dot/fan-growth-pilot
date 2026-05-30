import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { callHubFn } from "@/lib/hubApi";

type HubStats = {
  pendingDrafts: number;
  pitchLog24h: number;
  radioCount: number;
  igQueue: number;
};

const AdminHub: React.FC = () => {
  const [stats, setStats] = useState<HubStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [drafts, pitchLog, radio, ig] = await Promise.all([
          callHubFn<{ rows: { status: string }[] }>("list_drafts", { statuses: ["pending"] }),
          callHubFn<{ summary?: { email_pitches_last_24h?: number } }>("get_pitch_log", { limit: 1 }),
          callHubFn<{ targets: unknown[] }>("get_radio_targets", {}),
          callHubFn<{ rows: unknown[] }>("list_social_queue", { status: "pending", limit: 50 }),
        ]);
        setStats({
          pendingDrafts: drafts.rows?.length ?? 0,
          pitchLog24h: pitchLog.summary?.email_pitches_last_24h ?? 0,
          radioCount: radio.targets?.length ?? 0,
          igQueue: ig.rows?.length ?? 0,
        });
      } catch {
        setStats(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Command center</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Everything below maps to a live backend action. Playlist discovery and curator pitches are{" "}
          <strong>not</strong> the same as fan email blasts — use the right workflow.
        </p>
      </div>

      {!loading && stats && (
        <div className="flex flex-wrap gap-3 text-sm">
          {stats.pendingDrafts > 0 && (
            <span className="px-2 py-1 rounded-md bg-amber-500/15 text-amber-900 dark:text-amber-200">
              {stats.pendingDrafts} draft{stats.pendingDrafts === 1 ? "" : "s"} awaiting approval
            </span>
          )}
          <span className="px-2 py-1 rounded-md bg-muted text-muted-foreground">
            {stats.pitchLog24h} curator email{stats.pitchLog24h === 1 ? "" : "s"} sent (24h)
          </span>
          <span className="px-2 py-1 rounded-md bg-muted text-muted-foreground">
            {stats.radioCount} radio stations tracked
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <WorkflowCard
          title="Find playlists & pitch curators"
          subtitle="Firecrawl discovery → enrich contacts → 1:1 submission emails"
          steps={[
            "Find playlists (Quick or Full research)",
            "Enrich contacts (emails, IG queue)",
            "Set email on a row → Draft pitch",
            "Outreach → Approve & send (one curator at a time, cooldown armed)",
          ]}
          primary={{ label: "Open playlist pipeline", to: "/admin/playlists" }}
          secondary={[
            { label: "Review drafts", to: "/admin/outreach" },
            { label: "Pitch log", to: "/admin/pitch-log" },
            { label: "IG queue", to: "/admin/ig-queue" },
          ]}
          badge={stats?.pendingDrafts ? `${stats.pendingDrafts} pending` : undefined}
        />

        <WorkflowCard
          title="Fan email blasts"
          subtitle="Resend campaigns to your subscribed contact list (smart-link fans)"
          steps={[
            "Pick a campaign (template + from address)",
            "Preview → Send test to yourself",
            "Batch send (100 → 200 → rest) with dry-run first",
          ]}
          primary={{ label: "Open campaigns", to: "/admin/campaigns" }}
          secondary={[{ label: "Manage contacts", to: "/admin/contacts" }]}
          note="Not for Spotify curators. Use playlist pipeline above for curator pitches."
        />

        <WorkflowCard
          title="Radio / DJ outreach"
          subtitle="37 warm stations already spinning you — thank-you + new track pitch"
          steps={[
            "Backfill play-log baseline (once, for week-over-week spins)",
            "Patch station emails",
            "Draft → Send per station (radio_pitch_log)",
          ]}
          primary={{ label: "Open radio targets", to: "/admin/radio" }}
        />

        <WorkflowCard
          title="Reference"
          subtitle="Docs and deploy gates"
          steps={[
            "Playlist fast path: docs/PLAYLIST_PITCH_FAST_PATH.md",
            "After edge deploy: scripts/smoke-playlist-pipeline.sh",
          ]}
          primary={{ label: "Playlist targets (same as pipeline)", to: "/admin/playlists" }}
        />
      </div>
    </div>
  );
};

function WorkflowCard({
  title,
  subtitle,
  steps,
  primary,
  secondary,
  badge,
  note,
}: {
  title: string;
  subtitle: string;
  steps: string[];
  primary: { label: string; to: string };
  secondary?: { label: string; to: string }[];
  badge?: string;
  note?: string;
}) {
  return (
    <Card className="p-5 flex flex-col gap-4 h-full">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-medium">{title}</h2>
          {badge && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 shrink-0">{badge}</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
      </div>
      <ol className="text-sm space-y-1.5 list-decimal list-inside text-muted-foreground flex-1">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {note && <p className="text-xs text-amber-800 dark:text-amber-200/90 border-l-2 border-amber-500/50 pl-3">{note}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button asChild>
          <Link to={primary.to}>{primary.label}</Link>
        </Button>
        {secondary?.map((s) => (
          <Button key={s.to} variant="outline" size="sm" asChild>
            <Link to={s.to}>{s.label}</Link>
          </Button>
        ))}
      </div>
    </Card>
  );
}

export default AdminHub;
