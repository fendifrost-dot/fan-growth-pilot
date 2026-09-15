import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";
import { SAMPLE_FLAG_LABEL, SAMPLE_FLAGS, type SampleFlag } from "@/lib/syncRegisters";
import {
  blockerLabel,
  formatActorStamp,
  type SampleDeclarationValue,
  type SyncEligibilityPayload,
} from "@/lib/syncEligibility";

type Props = {
  trackId: string | null | undefined;
  onChanged?: () => void;
};

const TrackSyncEligibilityPanel: React.FC<Props> = ({ trackId, onChanged }) => {
  const [payload, setPayload] = useState<SyncEligibilityPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState<SampleDeclarationValue>("unknown");
  const [sampleExceptionResolved, setSampleExceptionResolved] = useState(false);

  const load = useCallback(async () => {
    if (!trackId) {
      setPayload(null);
      return;
    }
    setLoading(true);
    try {
      const data = await callHubFn<SyncEligibilityPayload>("get_sync_eligibility", {
        track_id: trackId,
      });
      setPayload(data);
      const declared = String(data.track?.has_sample ?? "unknown").toLowerCase();
      setSample(
        declared === "yes" || declared === "no" || declared === "unknown"
          ? declared
          : "unknown",
      );
      setSampleExceptionResolved(Boolean(data.track?.sample_exception_resolved));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load sync eligibility");
    } finally {
      setLoading(false);
    }
  }, [trackId]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterWrite = async () => {
    await load();
    onChanged?.();
  };

  const confirmSample = async () => {
    if (!trackId) return;
    setBusy(true);
    try {
      const res = await callHubFn<SyncEligibilityPayload & { error?: string }>(
        "approve_sample_declaration",
        {
          track_id: trackId,
          sample_declaration: sample,
          ...(sample === "yes" ? { sample_exception_resolved: sampleExceptionResolved } : {}),
        },
      );
      const eligible = res.eligibility?.eligible;
      toast.success(
        eligible
          ? "Sample declaration recorded. Track is currently sync-eligible."
          : "Sample declaration recorded. Sync eligibility is still blocked — see blockers.",
      );
      await afterWrite();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sample declaration failed");
    } finally {
      setBusy(false);
    }
  };

  const setSyncDecision = async (decision: "yes" | "no") => {
    if (!trackId) return;
    setBusy(true);
    try {
      const res = await callHubFn<{ eligibility?: { eligible?: boolean } }>(
        "approve_sync_eligibility",
        { track_id: trackId, decision },
      );
      const eligible = res.eligibility?.eligible === true;
      if (decision === "yes") {
        toast.success(
          eligible
            ? "Sync approval recorded. Computed eligibility is YES."
            : "Sync approval recorded. Computed eligibility is still NO — other blockers remain.",
        );
      } else {
        toast.success("Sync approval cleared. Computed eligibility was recomputed.");
      }
      await afterWrite();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync eligibility update failed");
    } finally {
      setBusy(false);
    }
  };

  const recompute = async () => {
    if (!trackId) return;
    setBusy(true);
    try {
      await callHubFn("recompute_sync_eligibility", { track_id: trackId });
      toast.success("Eligibility recomputed from current Hub rows");
      await afterWrite();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Recompute failed");
    } finally {
      setBusy(false);
    }
  };

  if (!trackId) {
    return (
      <div className="rounded-md border p-4 space-y-2" data-testid="sync-eligibility-panel">
        <h3 className="text-sm font-medium">Sync eligibility</h3>
        <p className="text-xs text-muted-foreground">
          Save the track first. Sync approve and sample declaration are per-song Hub controls —
          they are not applied from playlist approval or DNA lanes.
        </p>
      </div>
    );
  }

  const track = payload?.track;
  const dna = payload?.dna;
  const eligibility = payload?.eligibility;
  const computedEligible = eligibility?.eligible ?? payload?.computed_sync_eligible === true;
  const persistedEligible = track?.sync_eligible === true;
  const blockers = eligibility?.blockers?.length
    ? eligibility.blockers
    : track?.sync_eligible_blockers ?? [];
  const reasons = eligibility?.reasons ?? [];
  const conflict =
    payload?.dna_conflicts_with_computed === true ||
    (dna?.sync_recommendation
      ? (computedEligible && dna.sync_recommendation !== "approved") ||
        (!computedEligible && dna.sync_recommendation === "approved")
      : false);
  const sampleStamp = formatActorStamp(
    track?.sample_declaration_approved_at,
    track?.sample_declaration_approved_by,
  );
  const syncStamp = formatActorStamp(track?.sync_approved_at, track?.sync_approved_by);

  return (
    <div className="rounded-md border p-4 space-y-4" data-testid="sync-eligibility-panel">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Sync eligibility</h3>
          <div className="flex flex-wrap gap-1">
            <Badge variant={computedEligible ? "default" : "outline"} className="text-[10px]">
              Computed: {computedEligible ? "YES" : "NO"}
            </Badge>
            <Badge variant={persistedEligible ? "default" : "secondary"} className="text-[10px]">
              Stored: {persistedEligible ? "eligible" : "not eligible"}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Fendi-only. Setting YES records sync approval; the stored{" "}
          <code className="text-[10px]">tracks.sync_eligible</code> flag is recomputed from
          blockers and is never invented here. Playlist/outreach eligibility and Song DNA lanes
          do not grant sync.
        </p>
      </div>

      {loading && <p className="text-xs text-muted-foreground">Loading eligibility…</p>}

      {track?.outreach_eligibility && (
        <p className="text-[11px] text-muted-foreground">
          Playlist/outreach status on this track:{" "}
          <span className="font-medium">{track.outreach_eligibility}</span>
          {" — "}separate from sync.
        </p>
      )}

      {dna && (
        <div className="rounded-md bg-muted/50 p-3 space-y-1">
          <p className="text-xs font-medium">Approved Song DNA (not overwritten by this panel)</p>
          <p className="text-[11px] text-muted-foreground">
            v{dna.version_number ?? "?"} · sample {dna.sample_declaration ?? "—"} · sync
            recommendation <span className="font-medium">{dna.sync_recommendation ?? "—"}</span>
          </p>
          {conflict && (
            <p className="text-[11px] text-destructive" data-testid="sync-dna-conflict">
              DNA <code>sync_recommendation</code> is {dna.sync_recommendation}, while computed
              sync eligibility is {computedEligible ? "YES" : "NO"}. Both are shown; neither is
              silently overwritten.
            </p>
          )}
          <Link to="/admin/song-dna" className="text-[11px] underline">
            Open Song DNA
          </Link>
        </div>
      )}

      {!dna && (
        <p className="text-[11px] text-muted-foreground">
          No current approved Song DNA on this track.{" "}
          <Link to="/admin/song-dna" className="underline">
            Add / approve DNA
          </Link>{" "}
          — playlist lanes stay on DNA and do not imply sync.
        </p>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium">Current blockers</p>
        {blockers.length === 0 && computedEligible ? (
          <p className="text-[11px] text-muted-foreground">None — gate currently clear.</p>
        ) : blockers.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No persisted blocker codes. Recompute to refresh from Hub rows.
          </p>
        ) : (
          <ul className="text-[11px] space-y-1 list-disc pl-4" data-testid="sync-eligibility-blockers">
            {blockers.map((code, i) => (
              <li key={code}>
                <span className="font-medium">{blockerLabel(code)}</span>
                {reasons[i] ? <span className="text-muted-foreground"> — {reasons[i]}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">
          Readiness: assets {track?.assets_ready ? "ready" : "not ready"} · splits{" "}
          {track?.splits_ready ? "flagged" : "not ready"}
          {track?.splits_ready_source ? ` (${track.splits_ready_source})` : ""} · publishing{" "}
          {track?.publishing_ready ? "ready" : "not ready"}
          {track?.unresolved_rights_exception ? " · rights exception open" : ""}
        </p>
      </div>

      <div className="space-y-2 border-t pt-3">
        <Label>Sample declaration</Label>
        <Select
          value={sample}
          onValueChange={(v) => setSample(v as SampleDeclarationValue)}
        >
          <SelectTrigger data-testid="sync-sample-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SAMPLE_FLAGS.map((s) => (
              <SelectItem key={s} value={s}>
                {SAMPLE_FLAG_LABEL[s as SampleFlag]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {sample === "yes" && (
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={sampleExceptionResolved}
              onCheckedChange={(v) => setSampleExceptionResolved(Boolean(v))}
            />
            Sample exception resolved (clears sample-uncleared only with license evidence when required)
          </label>
        )}
        {sampleStamp && (
          <p className="text-[11px] text-muted-foreground">Last confirmed: {sampleStamp}</p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void confirmSample()}
          data-testid="confirm-sample-declaration"
        >
          Confirm sample declaration
        </Button>
      </div>

      <div className="space-y-2 border-t pt-3">
        <Label>Fendi sync approval</Label>
        <p className="text-[11px] text-muted-foreground">
          YES stamps <code>sync_approved_at/by</code> and recomputes eligibility. NO clears that
          approval. This does not change playlist outreach fields.
        </p>
        {syncStamp && (
          <p className="text-[11px] text-muted-foreground">Last approval: {syncStamp}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void setSyncDecision("yes")}
            data-testid="sync-eligibility-yes"
          >
            Set sync YES
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void setSyncDecision("no")}
            data-testid="sync-eligibility-no"
          >
            Set sync NO
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void recompute()}
            data-testid="sync-eligibility-recompute"
          >
            Recompute
          </Button>
        </div>
      </div>
    </div>
  );
};

export default TrackSyncEligibilityPanel;
