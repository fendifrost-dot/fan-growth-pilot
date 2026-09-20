import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Send, Building2, ShieldCheck, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { callHubFn } from "@/lib/hubApi";
import { PageHeader, HubLoading, HubEmpty } from "@/components/hub/HubPrimitives";
import { toast } from "sonner";

type LicensingPitch = {
  id: string;
  contact_name: string;
  contact_email: string | null;
  company: string | null;
  track_name: string;
  pitched_at: string;
  status: string;
  reply_received: boolean;
  placed: boolean;
  response_status: string;
};

type Supervisor = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  source: string | null;
};

type PendingDraft = {
  id: string;
  track_id: string;
  subject: string | null;
  status: string;
  approved_by_label?: string | null;
};

const statusVariant = (status: string | null | undefined) => {
  const s = (status || "").toLowerCase();
  if (s.includes("sent") || s.includes("placed") || s.includes("licensed") || s.includes("approved"))
    return "default";
  if (s.includes("error") || s.includes("reject") || s.includes("declined")) return "destructive";
  return "secondary";
};

const HubSync: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [pitches, setPitches] = useState<LicensingPitch[]>([]);
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [lg, sup, dr] = await Promise.all([
        callHubFn<{ rows: LicensingPitch[] }>("list_licensing_pitches", { limit: 100 }).catch(
          () => ({ rows: [] as LicensingPitch[] }),
        ),
        callHubFn<{ rows: Supervisor[] }>("list_music_supervisors", {}).catch(() => ({
          rows: [] as Supervisor[],
        })),
        callHubFn<{ drafts: PendingDraft[] }>("list_sync_pending_drafts", {
          status: "pending",
          limit: 50,
        }).catch(() => ({ drafts: [] as PendingDraft[] })),
      ]);
      setPitches(lg.rows ?? []);
      setSupervisors(sup.rows ?? []);
      setDrafts(dr.drafts ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load sync ops");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sync ops"
        description="Licensing outreach to music supervisors — sends, the contact roster, and drafts awaiting approval. Eligibility and Resend gates stay enforced in the operator tools."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            ↻ Refresh
          </Button>
        }
      />

      {loading ? (
        <HubLoading label="Loading sync ops…" />
      ) : (
        <Tabs defaultValue="sends">
          <TabsList>
            <TabsTrigger value="sends" className="gap-1.5">
              <Send className="w-4 h-4" /> Sends
              {pitches.length > 0 && <Badge variant="secondary">{pitches.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="opportunities" className="gap-1.5">
              <Building2 className="w-4 h-4" /> Opportunities
              {supervisors.length > 0 && <Badge variant="secondary">{supervisors.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="approvals" className="gap-1.5">
              <ShieldCheck className="w-4 h-4" /> Approvals
              {drafts.length > 0 && <Badge variant="secondary">{drafts.length}</Badge>}
            </TabsTrigger>
          </TabsList>

          {/* SENDS — licensing pitch log */}
          <TabsContent value="sends" className="space-y-4 mt-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/licensing">
                  Open licensing register <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </div>
            {pitches.length === 0 ? (
              <HubEmpty
                icon={Send}
                title="No sync sends yet"
                description="Licensing pitches to music supervisors will appear here once logged."
              />
            ) : (
              <div className="space-y-2">
                {pitches.slice(0, 50).map((p) => (
                  <Card
                    key={p.id}
                    className="p-4 flex items-center justify-between gap-3 bg-card/50 border-border"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{p.track_name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {p.contact_name}
                        {p.company ? ` · ${p.company}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {p.placed && <Badge>Licensed</Badge>}
                      {p.reply_received && !p.placed && <Badge variant="secondary">Replied</Badge>}
                      <Badge variant={statusVariant(p.response_status || p.status)}>
                        {p.response_status || p.status}
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* OPPORTUNITIES — supervisor roster */}
          <TabsContent value="opportunities" className="space-y-4 mt-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/licensing">
                  Manage roster <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </div>
            {supervisors.length === 0 ? (
              <HubEmpty
                icon={Building2}
                title="No supervisors on the roster"
                description="Add music supervisors and sync contacts to build your outreach pipeline."
              />
            ) : (
              <div className="space-y-2">
                {supervisors.map((s) => (
                  <Card
                    key={s.id}
                    className="p-4 flex items-center justify-between gap-3 bg-card/50 border-border"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{s.name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {[s.company, s.email].filter(Boolean).join(" · ") || "no contact"}
                      </p>
                    </div>
                    {s.source && <Badge variant="outline">{s.source}</Badge>}
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* APPROVALS — sync drafts awaiting approval */}
          <TabsContent value="approvals" className="space-y-4 mt-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/licensing">
                  Review drafts <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </div>
            {drafts.length === 0 ? (
              <HubEmpty
                icon={ShieldCheck}
                title="Nothing awaiting approval"
                description="Sync outreach drafts pending review will appear here. Approval and send stay gated in the operator tools."
              />
            ) : (
              <div className="space-y-2">
                {drafts.map((d) => (
                  <Card
                    key={d.id}
                    className="p-4 flex items-center justify-between gap-3 bg-card/50 border-border"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{d.subject || "Untitled draft"}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {d.approved_by_label ? `Approved by ${d.approved_by_label}` : "Awaiting review"}
                      </p>
                    </div>
                    <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};

export default HubSync;
