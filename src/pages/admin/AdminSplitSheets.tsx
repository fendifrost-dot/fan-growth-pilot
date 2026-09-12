import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type TrackOpt = { id: string; name: string };

type SheetRow = {
  id: string;
  track_id: string;
  track_name?: string | null;
  version_number: number;
  status: string;
  title: string | null;
  action_items?: string[] | null;
  document_kind?: string | null;
  document_storage_path?: string | null;
  is_current?: boolean;
  composition_total_percent?: number | null;
  master_total_percent?: number | null;
  one_stop_master?: boolean;
  publishing_controlled?: boolean;
  master_controlled?: boolean;
  dispute_reason?: string | null;
  confirmation_summary?: Record<string, unknown> | null;
  rights_readiness?: Record<string, unknown> | null;
  finalized_at?: string | null;
  fendi_approved_at?: string | null;
};

type Contributor = {
  id?: string;
  legal_name: string;
  role: string;
  split_percent: string;
  ownership_side?: string;
  pro_affiliation: string;
  ipi_number: string;
  confirmation_status?: string;
  publisher_name?: string;
};

type MasterOwner = {
  legal_name: string;
  ownership_percent: string;
  label_name: string;
  may_license_master: boolean;
};

type EvidenceRow = {
  id: string;
  evidence_kind: string;
  verification_status: string;
  storage_path?: string | null;
  notes?: string | null;
  created_at?: string;
};

type DeliveryRow = {
  id: string;
  recipient_name?: string | null;
  recipient_email?: string | null;
  delivery_reason: string;
  delivery_result: string;
  document_version: number;
  document_kind: string;
  created_at?: string;
  response_notes?: string | null;
};

type Readiness = {
  splits_ready?: boolean;
  splits_ready_source?: string | null;
  current_split_sheet_id?: string | null;
  blockers?: string[];
};

const emptyContributor = (): Contributor => ({
  legal_name: "",
  role: "writer",
  split_percent: "",
  ownership_side: "composition",
  pro_affiliation: "",
  ipi_number: "",
});

const emptyMaster = (): MasterOwner => ({
  legal_name: "",
  ownership_percent: "",
  label_name: "",
  may_license_master: false,
});

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  awaiting_contributor_confirmation: "Awaiting confirmation",
  partially_confirmed: "Partially confirmed",
  ready_for_fendi_review: "Ready for Fendi review",
  approved: "Approved",
  final: "Final",
  superseded: "Superseded",
  disputed: "Disputed",
  incomplete: "Draft (legacy)",
  ready_for_signatures: "Ready for Fendi review (legacy)",
  signed: "Historical signed label",
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case "draft":
    case "incomplete":
      return "bg-slate-100 text-slate-800 border-slate-300";
    case "awaiting_contributor_confirmation":
      return "bg-amber-50 text-amber-900 border-amber-300";
    case "partially_confirmed":
      return "bg-orange-50 text-orange-900 border-orange-300";
    case "ready_for_fendi_review":
    case "ready_for_signatures":
      return "bg-sky-50 text-sky-900 border-sky-300";
    case "approved":
      return "bg-emerald-50 text-emerald-900 border-emerald-300";
    case "final":
      return "bg-teal-100 text-teal-950 border-teal-400 font-semibold";
    case "superseded":
      return "bg-zinc-100 text-zinc-600 border-zinc-300 line-through decoration-zinc-400";
    case "disputed":
      return "bg-rose-100 text-rose-900 border-rose-400";
    default:
      return "";
  }
}

function documentKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "agh_generated_summary":
      return "AGH-generated summary (not signed)";
    case "contributor_confirmed":
      return "Contributor-confirmed summary";
    case "uploaded_signed":
      return "Uploaded signed document";
    case "provider_signed":
      return "Provider-signed document";
    default:
      return kind || "Unknown document class";
  }
}

const AdminSplitSheets: React.FC = () => {
  const [tracks, setTracks] = useState<TrackOpt[]>([]);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [trackId, setTrackId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    sheet: SheetRow;
    contributors: Contributor[];
    master_owners?: MasterOwner[];
    evidence?: EvidenceRow[];
  } | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [contributors, setContributors] = useState<Contributor[]>([emptyContributor()]);
  const [masters, setMasters] = useState<MasterOwner[]>([emptyMaster()]);
  const [disputeReason, setDisputeReason] = useState("");
  const [evidenceNotes, setEvidenceNotes] = useState("");
  const [evidenceKind, setEvidenceKind] = useState("uploaded_signed_split");
  const [confirmContributorId, setConfirmContributorId] = useState("");
  const [deliveryRequestReason, setDeliveryRequestReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [t, s] = await Promise.all([
        callHubFn<{ rows: TrackOpt[] }>("list_tracks"),
        callHubFn<{ rows: SheetRow[] }>("list_split_sheets", {}),
      ]);
      setTracks(t.rows ?? []);
      setRows(s.rows ?? []);
    } catch (e) {
      const msg = (e as Error).message || "Failed to load split sheets";
      setLoadError(msg);
      setRows([]);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const versionHistory = useMemo(() => {
    if (!detail?.sheet) return [];
    const tid = detail.sheet.track_id;
    return rows
      .filter((r) => r.track_id === tid)
      .slice()
      .sort((a, b) => b.version_number - a.version_number);
  }, [detail, rows]);

  const compositionRows = useMemo(
    () => (detail?.contributors ?? []).filter((c) => (c.ownership_side ?? "composition") !== "master"),
    [detail],
  );
  const masterFromContributors = useMemo(
    () => (detail?.contributors ?? []).filter((c) => c.ownership_side === "master"),
    [detail],
  );

  const compositionTotal = useMemo(() => {
    if (detail?.sheet.composition_total_percent != null) {
      return Number(detail.sheet.composition_total_percent);
    }
    return compositionRows.reduce((s, c) => s + (Number(c.split_percent) || 0), 0);
  }, [detail, compositionRows]);

  const masterTotal = useMemo(() => {
    if (detail?.sheet.master_total_percent != null) {
      return Number(detail.sheet.master_total_percent);
    }
    const fromOwners = (detail?.master_owners ?? []).reduce(
      (s, m) => s + (Number(m.ownership_percent) || 0),
      0,
    );
    if (fromOwners) return fromOwners;
    return masterFromContributors.reduce((s, c) => s + (Number(c.split_percent) || 0), 0);
  }, [detail, masterFromContributors]);

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setSignedUrl(null);
    setPreviewHtml(null);
    setBusy(true);
    try {
      const res = await callHubFn<{
        sheet: SheetRow;
        contributors: Contributor[];
        master_owners?: MasterOwner[];
        evidence?: EvidenceRow[];
      }>("get_split_sheet", { split_sheet_id: id });
      setDetail({
        sheet: res.sheet,
        contributors: res.contributors ?? [],
        master_owners: res.master_owners ?? [],
        evidence: res.evidence ?? [],
      });
      const tid = res.sheet.track_id;
      const [del, ready] = await Promise.all([
        callHubFn<{ rows: DeliveryRow[] }>("list_split_sheet_deliveries", {
          track_id: tid,
          split_sheet_id: id,
        }).catch(() => ({ rows: [] as DeliveryRow[] })),
        callHubFn<Readiness>("get_track_split_readiness", { track_id: tid }).catch(
          () => null,
        ),
      ]);
      setDeliveries(del.rows ?? []);
      setReadiness(ready);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load sheet");
      setDetail(null);
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async () => {
    if (!trackId) {
      toast.error("Pick a track");
      return;
    }
    setBusy(true);
    try {
      const res = await callHubFn<{
        action_items?: string[];
        sheet?: { id: string };
        split_sheet_id?: string;
        ok?: boolean;
        errors?: string[];
      }>("create_split_sheet_version", {
        track_id: trackId,
        composition: contributors.map((c) => ({
          legal_name: c.legal_name.trim() || null,
          role: c.role,
          split_percent: c.split_percent === "" ? null : Number(c.split_percent),
          pro_affiliation: c.pro_affiliation.trim() || null,
          ipi_number: c.ipi_number.trim() || null,
        })),
        master: masters
          .filter((m) => m.legal_name.trim() || m.ownership_percent)
          .map((m) => ({
            legal_name: m.legal_name.trim() || null,
            ownership_percent: m.ownership_percent === "" ? null : Number(m.ownership_percent),
            label_name: m.label_name.trim() || null,
            may_license_master: m.may_license_master,
          })),
      });
      if (res.ok === false || res.errors?.length) {
        toast.error((res.errors ?? ["Validation failed"]).join("; "));
        return;
      }
      const items = res.action_items ?? [];
      toast.success(
        items.length
          ? `Version created with ${items.length} missing-info items`
          : "Split sheet version created (draft)",
      );
      await load();
      const id = res.sheet?.id ?? res.split_sheet_id;
      if (id) {
        const doc = await callHubFn<{ html?: string }>("regenerate_split_sheet_document", {
          split_sheet_id: id,
        }).catch(() => ({ html: undefined }));
        setPreviewHtml(doc.html ?? null);
        await openDetail(id);
      }
    } catch (e) {
      toast.error((e as Error).message || "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const submitForReview = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await callHubFn("submit_split_sheet_for_fendi_review", { split_sheet_id: selectedId });
      toast.success("Submitted for Fendi review");
      await openDetail(selectedId);
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Submit failed");
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await callHubFn("finalize_split_sheet", { split_sheet_id: selectedId });
      toast.success("Finalized (Fendi)");
      await openDetail(selectedId);
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Finalize failed");
    } finally {
      setBusy(false);
    }
  };

  const markDisputed = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await callHubFn("mark_split_sheet_disputed", {
        split_sheet_id: selectedId,
        dispute_reason: disputeReason.trim() || null,
      });
      toast.success("Marked disputed");
      await openDetail(selectedId);
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Dispute failed");
    } finally {
      setBusy(false);
    }
  };

  const uploadEvidenceNote = async () => {
    if (!selectedId || !detail) return;
    setBusy(true);
    try {
      await callHubFn("upload_split_sheet_evidence", {
        split_sheet_id: selectedId,
        track_id: detail.sheet.track_id,
        evidence_kind: evidenceKind,
        notes: evidenceNotes.trim() || null,
        verification_status: "unverified",
      });
      toast.success("Evidence record saved (not labeled signed until verified)");
      setEvidenceNotes("");
      await openDetail(selectedId);
    } catch (e) {
      toast.error((e as Error).message || "Evidence save failed");
    } finally {
      setBusy(false);
    }
  };

  const recordConfirmation = async () => {
    if (!selectedId || !confirmContributorId) {
      toast.error("Select a contributor");
      return;
    }
    setBusy(true);
    try {
      await callHubFn("record_contributor_confirmation", {
        split_sheet_id: selectedId,
        contributor_id: confirmContributorId,
        confirmation_status: "confirmed",
        confirmation_method: "admin_recorded",
      });
      toast.success("Contributor confirmation recorded");
      await openDetail(selectedId);
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Confirmation failed");
    } finally {
      setBusy(false);
    }
  };

  const requestDeliveryAuthorization = async () => {
    if (!selectedId || !detail) return;
    setBusy(true);
    try {
      await callHubFn("request_split_sheet_delivery_authorization", {
        track_id: detail.sheet.track_id,
        split_sheet_id: selectedId,
        reason: deliveryRequestReason.trim() || "recipient_requested",
      });
      toast.success("Delivery authorization requested (awaiting Fendi)");
      setDeliveryRequestReason("");
    } catch (e) {
      toast.error((e as Error).message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const openFinalDocument = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await callHubFn<{ url?: string; html?: string; document_kind?: string }>(
        "get_split_sheet_signed_url",
        { split_sheet_id: selectedId },
      );
      if (res.url) {
        setSignedUrl(res.url);
        toast.message(
          res.document_kind === "uploaded_signed" || res.document_kind === "provider_signed"
            ? "Secure link ready (expires soon)"
            : "Secure link to generated summary (not a signed document)",
        );
      } else if (res.html) {
        setPreviewHtml(res.html);
        toast.message("Showing AGH-generated HTML summary — not a signed document");
      } else {
        toast.error("No document available");
      }
    } catch (e) {
      toast.error((e as Error).message || "Could not open document");
    } finally {
      setBusy(false);
    }
  };

  const totalsOk =
    Math.abs(compositionTotal - 100) <= 0.01 &&
    (masterTotal === 0 || Math.abs(masterTotal - 100) <= 0.01);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Split sheets</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Authoritative composition + master ownership. Generated HTML is a summary — never labeled
          signed. Corrections create a new version; finalized sheets are immutable.
        </p>
      </div>

      <Card className="p-5 space-y-4">
        <h2 className="font-medium">Create version</h2>
        <div className="space-y-1.5 max-w-md">
          <Label>Track</Label>
          <Select value={trackId || undefined} onValueChange={setTrackId}>
            <SelectTrigger>
              <SelectValue placeholder="Select track" />
            </SelectTrigger>
            <SelectContent>
              {tracks.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <h3 className="text-sm font-medium pt-2">Composition shares</h3>
        {contributors.map((c, idx) => (
          <div key={idx} className="grid gap-2 md:grid-cols-5 border-t pt-3">
            <Input
              placeholder="Legal name"
              value={c.legal_name}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, legal_name: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="Role"
              value={c.role}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, role: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="Split %"
              value={c.split_percent}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, split_percent: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="PRO"
              value={c.pro_affiliation}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, pro_affiliation: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="IPI"
              value={c.ipi_number}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, ipi_number: e.target.value } : r)),
                )
              }
            />
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setContributors((rows) => [...rows, emptyContributor()])}
          >
            Add composer
          </Button>
        </div>

        <h3 className="text-sm font-medium pt-2">Master ownership</h3>
        {masters.map((m, idx) => (
          <div key={idx} className="grid gap-2 md:grid-cols-4 border-t pt-3">
            <Input
              placeholder="Legal name"
              value={m.legal_name}
              onChange={(e) =>
                setMasters((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, legal_name: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="Ownership %"
              value={m.ownership_percent}
              onChange={(e) =>
                setMasters((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, ownership_percent: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="Label"
              value={m.label_name}
              onChange={(e) =>
                setMasters((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, label_name: e.target.value } : r)),
                )
              }
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={m.may_license_master}
                onChange={(e) =>
                  setMasters((rows) =>
                    rows.map((r, i) =>
                      i === idx ? { ...r, may_license_master: e.target.checked } : r,
                    ),
                  )
                }
              />
              May license master
            </label>
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setMasters((rows) => [...rows, emptyMaster()])}>
            Add master owner
          </Button>
          <Button disabled={busy || !trackId} onClick={() => void createVersion()}>
            Create split sheet version
          </Button>
        </div>
      </Card>

      {previewHtml && (
        <Card className="p-5">
          <h2 className="font-medium mb-1">Generated summary preview</h2>
          <p className="text-xs text-muted-foreground mb-3">
            This is an AGH-generated HTML summary — not a signed document.
          </p>
          <iframe
            title="Split sheet preview"
            className="w-full h-96 border rounded bg-white"
            srcDoc={previewHtml}
          />
        </Card>
      )}

      <Card className="p-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Track</th>
              <th className="text-left p-3">Ver</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Document</th>
              <th className="text-left p-3">Missing / action items</th>
              <th className="text-left p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="p-3 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && loadError && (
              <tr>
                <td colSpan={6} className="p-3">
                  <p className="font-medium text-destructive">Split sheets could not be loaded</p>
                  <p className="text-sm text-muted-foreground break-words">{loadError}</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
                    Retry
                  </Button>
                </td>
              </tr>
            )}
            {!loading && !loadError && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-3 text-muted-foreground">
                  No split sheets yet. Create a version above.
                </td>
              </tr>
            )}
            {!loading &&
              !loadError &&
              rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-3">{r.track_name ?? r.track_id.slice(0, 8)}</td>
                  <td className="p-3 font-mono text-xs">
                    v{r.version_number}
                    {r.is_current ? " · current" : ""}
                  </td>
                  <td className="p-3">
                    <Badge variant="outline" className={statusBadgeClass(r.status)}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </Badge>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {documentKindLabel(r.document_kind)}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {(r.action_items ?? []).length
                      ? (r.action_items ?? []).join("; ")
                      : "None"}
                  </td>
                  <td className="p-3 text-right">
                    <Button size="sm" variant="outline" onClick={() => void openDetail(r.id)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

      {detail && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium text-lg">
                {detail.sheet.title || `v${detail.sheet.version_number}`}
              </h2>
              <Badge variant="outline" className={statusBadgeClass(detail.sheet.status)}>
                {STATUS_LABEL[detail.sheet.status] ?? detail.sheet.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {documentKindLabel(detail.sheet.document_kind)}
            </p>

            <div>
              <h3 className="text-sm font-medium mb-2">Version history</h3>
              <ul className="text-sm space-y-1">
                {versionHistory.map((v) => (
                  <li key={v.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline font-mono text-xs"
                      onClick={() => void openDetail(v.id)}
                    >
                      v{v.version_number}
                    </button>
                    <Badge variant="outline" className={statusBadgeClass(v.status)}>
                      {STATUS_LABEL[v.status] ?? v.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2">Composition shares</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1">Name</th>
                    <th>Role</th>
                    <th>%</th>
                    <th>Confirm</th>
                  </tr>
                </thead>
                <tbody>
                  {compositionRows.map((c, i) => (
                    <tr key={c.id ?? i} className="border-t">
                      <td className="py-1">{c.legal_name || "—"}</td>
                      <td>{c.role}</td>
                      <td>{c.split_percent ?? "—"}</td>
                      <td className="text-xs">{c.confirmation_status ?? "unconfirmed"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p
                className={`text-xs mt-2 ${
                  Math.abs(compositionTotal - 100) <= 0.01
                    ? "text-emerald-700"
                    : "text-destructive"
                }`}
              >
                Composition total: {compositionTotal.toFixed(2)}%
                {Math.abs(compositionTotal - 100) > 0.01 ? " (must equal 100%)" : ""}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2">Master ownership</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1">Name</th>
                    <th>%</th>
                    <th>Label</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.master_owners?.length
                    ? detail.master_owners
                    : masterFromContributors.map((c) => ({
                        legal_name: c.legal_name,
                        ownership_percent: String(c.split_percent ?? ""),
                        label_name: "",
                        may_license_master: false,
                      }))
                  ).map((m, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-1">{m.legal_name || "—"}</td>
                      <td>{m.ownership_percent || "—"}</td>
                      <td className="text-xs text-muted-foreground">
                        {"label_name" in m ? m.label_name || "—" : "—"}
                      </td>
                    </tr>
                  ))}
                  {!detail.master_owners?.length && masterFromContributors.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-2 text-muted-foreground text-xs">
                        No master owners recorded
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p
                className={`text-xs mt-2 ${
                  masterTotal === 0 || Math.abs(masterTotal - 100) <= 0.01
                    ? "text-muted-foreground"
                    : "text-destructive"
                }`}
              >
                Master total: {masterTotal.toFixed(2)}%
                {masterTotal > 0 && Math.abs(masterTotal - 100) > 0.01
                  ? " (must equal 100%)"
                  : ""}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Totals validation: {totalsOk ? "OK" : "Failed"}
                {detail.sheet.one_stop_master ? " · one-stop master" : ""}
                {detail.sheet.publishing_controlled ? " · publishing controlled" : ""}
                {detail.sheet.master_controlled ? " · master controlled" : ""}
              </p>
            </div>

            {(detail.sheet.action_items?.length || detail.sheet.dispute_reason) && (
              <div>
                <h3 className="text-sm font-medium mb-1">Missing info / disputes</h3>
                {detail.sheet.dispute_reason && (
                  <p className="text-sm text-rose-800 mb-1">Dispute: {detail.sheet.dispute_reason}</p>
                )}
                <ul className="text-sm list-disc pl-5 text-muted-foreground">
                  {(detail.sheet.action_items ?? []).map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card className="p-5 space-y-4">
            <div>
              <h3 className="text-sm font-medium mb-2">Evidence</h3>
              {(detail.evidence ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No evidence uploaded</p>
              ) : (
                <ul className="text-sm space-y-1">
                  {(detail.evidence ?? []).map((e) => (
                    <li key={e.id} className="border-t pt-1">
                      <span className="font-medium">{e.evidence_kind}</span> ·{" "}
                      {e.verification_status}
                      {e.notes ? ` — ${e.notes}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2">Sync readiness effect</h3>
              {readiness ? (
                <p className="text-sm">
                  splits_ready={String(readiness.splits_ready)} · source=
                  {readiness.splits_ready_source ?? "—"}
                  {(readiness.blockers?.length ?? 0) > 0
                    ? ` · blockers: ${readiness.blockers!.join(", ")}`
                    : ""}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Readiness unavailable</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void openFinalDocument()}
              >
                Open document (secure link)
              </Button>
              {signedUrl && (
                <a
                  className="text-sm underline self-center"
                  href={signedUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open secure link
                </a>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || detail.sheet.status === "final"}
                onClick={() => void submitForReview()}
              >
                Submit for Fendi review
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void finalize()}>
                Finalize (Fendi only)
              </Button>
            </div>

            <div className="space-y-2 border-t pt-3">
              <Label>Dispute reason</Label>
              <Textarea
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                rows={2}
              />
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void markDisputed()}
              >
                Mark disputed
              </Button>
            </div>

            <div className="space-y-2 border-t pt-3">
              <h3 className="text-sm font-medium">Record evidence / confirmation</h3>
              <p className="text-xs text-muted-foreground">
                Uploaded evidence is never labeled “signed” until verification. AGH-generated HTML is
                an ownership summary only.
              </p>
              <Label>Evidence kind</Label>
              <Select value={evidenceKind} onValueChange={setEvidenceKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="uploaded_signed_split">Uploaded signed split</SelectItem>
                  <SelectItem value="contributor_confirmation">Contributor confirmation</SelectItem>
                  <SelectItem value="signature_provider_ref">Signature provider ref</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
              <Textarea
                placeholder="Evidence notes / storage reference"
                value={evidenceNotes}
                onChange={(e) => setEvidenceNotes(e.target.value)}
                rows={2}
              />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void uploadEvidenceNote()}>
                Save evidence record
              </Button>
              <Label className="mt-2">Confirm contributor</Label>
              <Select value={confirmContributorId} onValueChange={setConfirmContributorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select contributor" />
                </SelectTrigger>
                <SelectContent>
                  {(detail.contributors ?? [])
                    .filter((c) => c.id)
                    .map((c) => (
                      <SelectItem key={c.id!} value={c.id!}>
                        {c.legal_name || "Unnamed"} ({c.confirmation_status || "unconfirmed"})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordConfirmation()}>
                Record confirmation
              </Button>
            </div>

            <div className="space-y-2 border-t pt-3">
              <h3 className="text-sm font-medium">Request delivery authorization</h3>
              <p className="text-xs text-muted-foreground">
                Default policy is request_only. Grok may request; only Fendi grants. Initial pitches
                never auto-attach the full sheet.
              </p>
              <Textarea
                placeholder="Reason (recipient requested / opportunity requires)"
                value={deliveryRequestReason}
                onChange={(e) => setDeliveryRequestReason(e.target.value)}
                rows={2}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || detail.sheet.status !== "final"}
                onClick={() => void requestDeliveryAuthorization()}
              >
                Request Fendi delivery authorization
              </Button>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2">Delivery history</h3>
              {deliveries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No deliveries logged</p>
              ) : (
                <ul className="text-sm space-y-2">
                  {deliveries.map((d) => (
                    <li key={d.id} className="border-t pt-2">
                      <div>
                        {d.recipient_name || d.recipient_email || "Recipient"} · {d.delivery_reason}{" "}
                        · {d.delivery_result}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        v{d.document_version} · {documentKindLabel(d.document_kind)}
                        {d.created_at ? ` · ${d.created_at}` : ""}
                      </div>
                      {d.response_notes && (
                        <div className="text-xs mt-1">Response: {d.response_notes}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default AdminSplitSheets;
