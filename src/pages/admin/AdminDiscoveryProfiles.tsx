import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";
import { parseLaneList } from "@/lib/songDna";

type DiscoveryProfile = {
  id: string;
  profile_key: string;
  label: string;
  is_active: boolean;
  approval_status: string;
  genre_family: string | null;
  included_search_terms: string[];
  excluded_search_terms: string[];
  reference_artists: string[];
  compatible_target_category_slugs: string[];
  search_weight: number;
  approved_lanes: string[];
  excluded_lanes: string[];
  matching_expression: string | null;
  allocation_share: number | null;
};

const emptyForm = {
  profile_key: "",
  label: "",
  genre_family: "",
  included_search_terms: "",
  excluded_search_terms: "",
  reference_artists: "",
  compatible_target_category_slugs: "",
  approved_lanes: "",
  excluded_lanes: "",
  matching_expression: "",
  search_weight: "1",
  allocation_share: "",
  is_active: true,
  reason: "",
};

const AdminDiscoveryProfiles: React.FC = () => {
  const [profiles, setProfiles] = useState<DiscoveryProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        callHubFn<{ profiles: DiscoveryProfile[] }>("list_discovery_profiles"),
        callHubFn<{ report: Record<string, unknown> }>("outreach_cutover_readiness").catch(() => null),
      ]);
      setProfiles(p.profiles ?? []);
      setReport(r?.report ?? null);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load discovery profiles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form.profile_key.trim()) {
      toast.error("profile_key required");
      return;
    }
    setBusy(true);
    try {
      await callHubFn("upsert_discovery_profile", {
        profile_key: form.profile_key.trim(),
        label: form.label.trim() || form.profile_key.trim(),
        genre_family: form.genre_family.trim() || null,
        included_search_terms: parseLaneList(form.included_search_terms),
        excluded_search_terms: parseLaneList(form.excluded_search_terms),
        reference_artists: parseLaneList(form.reference_artists),
        compatible_target_category_slugs: parseLaneList(form.compatible_target_category_slugs),
        approved_lanes: parseLaneList(form.approved_lanes),
        excluded_lanes: parseLaneList(form.excluded_lanes),
        matching_expression: form.matching_expression.trim() || null,
        search_weight: Number(form.search_weight) || 1,
        allocation_share: form.allocation_share === "" ? null : Number(form.allocation_share),
        is_active: form.is_active,
        reason: form.reason.trim() || undefined,
      });
      toast.success("Profile saved (pending Fendi approval unless already approved)");
      setForm(emptyForm);
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string) => {
    setBusy(true);
    try {
      await callHubFn("approve_discovery_profile", { id, reason: "fendi_approved" });
      toast.success("Discovery profile approved");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Approve failed");
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (id: string) => {
    setBusy(true);
    try {
      await callHubFn("deactivate_discovery_profile", { id, reason: "operator_deactivate" });
      toast.success("Deactivated (not hard-deleted)");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Deactivate failed");
    } finally {
      setBusy(false);
    }
  };

  const edit = (p: DiscoveryProfile) => {
    setForm({
      profile_key: p.profile_key,
      label: p.label,
      genre_family: p.genre_family ?? "",
      included_search_terms: (p.included_search_terms ?? []).join(", "),
      excluded_search_terms: (p.excluded_search_terms ?? []).join(", "),
      reference_artists: (p.reference_artists ?? []).join(", "),
      compatible_target_category_slugs: (p.compatible_target_category_slugs ?? []).join(", "),
      approved_lanes: (p.approved_lanes ?? []).join(", "),
      excluded_lanes: (p.excluded_lanes ?? []).join(", "),
      matching_expression: p.matching_expression ?? "",
      search_weight: String(p.search_weight ?? 1),
      allocation_share: p.allocation_share == null ? "" : String(p.allocation_share),
      is_active: p.is_active,
      reason: "",
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Discovery profiles</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Database-managed search terms, allocation, lanes, and matching expressions. Seeded
          profiles stay <strong>pending Fendi review</strong> until you approve them.{" "}
          <Link to="/admin/song-dna" className="underline">
            Song DNA
          </Link>{" "}
          controls per-track routing.
        </p>
      </div>

      {report && (
        <Card className="p-5 space-y-2">
          <h2 className="font-medium">Cutover readiness</h2>
          <pre className="text-xs overflow-auto bg-muted/40 p-3 rounded-md">
            {JSON.stringify(report, null, 2)}
          </pre>
        </Card>
      )}

      <Card className="p-5 space-y-4">
        <h2 className="font-medium">Create / update profile</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>profile_key</Label>
            <Input
              value={form.profile_key}
              onChange={(e) => setForm((f) => ({ ...f, profile_key: e.target.value }))}
              placeholder="stable_key"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Genre family (operator label)</Label>
            <Input
              value={form.genre_family}
              onChange={(e) => setForm((f) => ({ ...f, genre_family: e.target.value }))}
              placeholder="e.g. rap, house — not hard-coded in source"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Allocation share</Label>
            <Input
              value={form.allocation_share}
              onChange={(e) => setForm((f) => ({ ...f, allocation_share: e.target.value }))}
              placeholder="0.55"
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Included search terms</Label>
            <Textarea
              rows={2}
              value={form.included_search_terms}
              onChange={(e) => setForm((f) => ({ ...f, included_search_terms: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Excluded search terms</Label>
            <Input
              value={form.excluded_search_terms}
              onChange={(e) => setForm((f) => ({ ...f, excluded_search_terms: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Approved lanes</Label>
            <Input
              value={form.approved_lanes}
              onChange={(e) => setForm((f) => ({ ...f, approved_lanes: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Excluded lanes</Label>
            <Input
              value={form.excluded_lanes}
              onChange={(e) => setForm((f) => ({ ...f, excluded_lanes: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Matching expression (validated regex)</Label>
            <Input
              value={form.matching_expression}
              onChange={(e) => setForm((f) => ({ ...f, matching_expression: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Reference artists</Label>
            <Input
              value={form.reference_artists}
              onChange={(e) => setForm((f) => ({ ...f, reference_artists: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={form.is_active}
              onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))}
            />
            <Label>Active</Label>
          </div>
          <div className="space-y-1.5">
            <Label>Change reason (audit)</Label>
            <Input
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
        </div>
        <Button disabled={busy} onClick={() => void save()}>
          Save profile
        </Button>
      </Card>

      <Card className="p-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Key</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Family</th>
              <th className="text-left p-3">Terms</th>
              <th className="text-right p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="p-3 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && profiles.length === 0 && (
              <tr>
                <td colSpan={5} className="p-3 text-muted-foreground">
                  No profiles yet — apply the DNA/discovery migration via Lovable SQL Editor.
                </td>
              </tr>
            )}
            {profiles.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="p-3">
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs font-mono text-muted-foreground">{p.profile_key}</div>
                </td>
                <td className="p-3">
                  <Badge variant={p.approval_status === "approved" ? "default" : "outline"}>
                    {p.approval_status}
                  </Badge>
                  {!p.is_active && (
                    <Badge variant="secondary" className="ml-1">
                      inactive
                    </Badge>
                  )}
                </td>
                <td className="p-3 text-xs">{p.genre_family || "—"}</td>
                <td className="p-3 text-xs max-w-xs truncate">
                  {(p.included_search_terms ?? []).slice(0, 6).join(", ")}
                </td>
                <td className="p-3 text-right space-x-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(p)}>
                    Edit
                  </Button>
                  {p.approval_status !== "approved" && (
                    <Button size="sm" disabled={busy} onClick={() => void approve(p.id)}>
                      Approve
                    </Button>
                  )}
                  {p.is_active && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void deactivate(p.id)}
                    >
                      Deactivate
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default AdminDiscoveryProfiles;
