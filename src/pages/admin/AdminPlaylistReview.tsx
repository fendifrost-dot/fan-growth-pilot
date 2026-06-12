import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type ReviewRow = {
  playlist_id: string;
  playlist_name: string | null;
  curator_name: string | null;
  curator_email: string | null;
  platform: string | null;
  contact_method: string | null;
  submission_cost: string | null;
  verification_status: string;
  verification_notes: string | null;
  bounce_count: number | null;
};

const REJECT_CATEGORIES = ["non_curator", "lending", "real_estate", "analytics", "academic", "invalid_tld", "manual"];

const AdminPlaylistReview: React.FC = () => {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: ReviewRow[] }>("list_unverified_targets", {});
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const runAutoVerify = async () => {
    setBusy("auto");
    try {
      const res = await callHubFn<{ checked: number; verified: number; flagged: number }>("verify_targets", { limit: 200 });
      toast.success(`Auto-verify: ${res.verified} passed, ${res.flagged} flagged of ${res.checked} checked`);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const review = async (row: ReviewRow, decision: "approve" | "reject", category?: string) => {
    setBusy(row.playlist_id);
    try {
      await callHubFn("review_target", {
        playlist_id: row.playlist_id,
        decision,
        curator_email: row.curator_email ?? undefined,
        category,
      });
      toast.success(decision === "approve" ? "Approved — draftable now" : "Rejected — domain blocked from re-scrape");
      setRows((rs) => rs.filter((r) => r.playlist_id !== row.playlist_id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin/playlists" className="text-xs text-muted-foreground hover:underline">← Find playlists</Link>
        <div className="flex items-center justify-between mt-1">
          <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
          <Button size="sm" disabled={busy === "auto"} onClick={runAutoVerify}>
            {busy === "auto" ? "Running…" : "Run auto-verify"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Targets that haven't passed verification. Auto-verify checks email format, TLD, MX
          records and the blocklist. Approve to make a target draftable; reject to block its
          domain from future scrapes.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to review — every target is verified or rejected. 🎉</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.playlist_id} className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">{r.playlist_name ?? r.playlist_id}</span>
                  {r.platform && <span className="text-[10px] uppercase rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{r.platform}</span>}
                  <span className="text-[10px] uppercase rounded bg-yellow-500/15 text-yellow-600 px-1.5 py-0.5">{r.verification_status}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {r.curator_name ? `${r.curator_name} · ` : ""}{r.curator_email ?? "no email"}
                  {r.contact_method ? ` · ${r.contact_method}` : ""}{r.submission_cost && r.submission_cost !== "unknown" ? ` · ${r.submission_cost}` : ""}
                  {r.bounce_count ? ` · ${r.bounce_count} bounce(s)` : ""}
                </div>
                {r.verification_notes && (
                  <div className="text-xs text-red-600/90 mt-1">⚠ {r.verification_notes}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <Button size="sm" variant="secondary" disabled={busy === r.playlist_id} onClick={() => review(r, "approve")}>
                  Approve
                </Button>
                <select
                  className="h-8 rounded border bg-background px-2 text-xs"
                  value=""
                  disabled={busy === r.playlist_id}
                  onChange={(e) => { if (e.target.value) review(r, "reject", e.target.value); }}
                  title="Reject with category"
                >
                  <option value="">Reject as…</option>
                  {REJECT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default AdminPlaylistReview;
