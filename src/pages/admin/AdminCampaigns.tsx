import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";

interface CampaignRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  from_email: string;
  real_sent: number;
  real_failed: number;
  test_sends: number;
  last_send_at: string | null;
  created_at: string;
}

const AdminCampaigns: React.FC = () => {
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("email_campaign_stats")
        .select("*")
        .order("created_at", { ascending: false });
      if (!error) setRows((data ?? []) as CampaignRow[]);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Campaigns</h1>
        <p className="text-sm text-muted-foreground mt-1">Send emails through Resend with full attribution.</p>
      </div>

      <Card className="p-5">
        <div className="rounded border overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3">Campaign</th>
                <th className="text-left p-3">From</th>
                <th className="text-left p-3">Status</th>
                <th className="text-right p-3">Sent</th>
                <th className="text-right p-3">Failed</th>
                <th className="text-right p-3">Tests</th>
                <th className="text-left p-3">Last send</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="p-3 text-muted-foreground">Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={7} className="p-3 text-muted-foreground">No campaigns yet</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} className="border-t hover:bg-muted/30">
                  <td className="p-3">
                    <Link className="font-medium hover:underline" to={`/admin/campaigns/${r.slug}`}>{r.name}</Link>
                    <div className="text-xs text-muted-foreground">{r.slug}</div>
                  </td>
                  <td className="p-3 text-xs">{r.from_email}</td>
                  <td className="p-3 text-xs">
                    <span className={
                      r.status === "completed" ? "text-emerald-700" :
                      r.status === "sending"   ? "text-blue-700" :
                      r.status === "paused"    ? "text-amber-700" :
                      "text-muted-foreground"
                    }>{r.status}</span>
                  </td>
                  <td className="p-3 text-right font-mono text-xs">{r.real_sent}</td>
                  <td className="p-3 text-right font-mono text-xs">{r.real_failed}</td>
                  <td className="p-3 text-right font-mono text-xs">{r.test_sends}</td>
                  <td className="p-3 text-xs text-muted-foreground">{r.last_send_at ? new Date(r.last_send_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export default AdminCampaigns;
