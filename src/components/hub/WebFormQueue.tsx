import React, { useState } from "react";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callHubFn } from "@/lib/hubApi";
import { HubEmpty } from "@/components/hub/HubPrimitives";
import { toast } from "sonner";

export const WEB_FORM_EMPTY_COPY =
  "No web forms are waiting. Approve, reject, and mark-submitted stay here so you can use them as soon as a form shows up.";

export type WebFormRow = {
  id: string;
  batch_id: string;
  track_name: string | null;
  playlist_name: string | null;
  form_url: string | null;
  queue_state: string;
  approved_by: string | null;
  blockers: string[];
};

type ReviewBody = {
  ok?: boolean;
  applied_count?: number;
  skipped?: { reason?: string }[];
  error?: string;
};

function plainSkip(code: string | undefined): string {
  switch (code) {
    case "pass_review_required":
      return "Approval needs a PASS, and the song has to fit this playlist's lane.";
    case "dna_gate":
      return "Song DNA does not allow this playlist's lane.";
    case "review_required":
      return "This form has to be reviewed before it can be approved.";
    case "route_unverified":
      return "This playlist route is not verified yet.";
    case "reason_required":
      return "A reject reason is required.";
    case "not_in_review":
      return "This form cannot be rejected from its current state.";
    case "already_submitted":
      return "This form was already marked submitted.";
    case "record_held":
      return "This playlist is on hold or the review was deferred.";
    default:
      return code ? `This form could not be updated (${code}).` : "This form could not be updated.";
  }
}

function appliedOrThrow(result: ReviewBody, fallback: string) {
  if (result.ok === false) throw new Error(result.error || fallback);
  if ((result.applied_count ?? 0) < 1) {
    throw new Error(plainSkip(result.skipped?.[0]?.reason));
  }
}

export const WebFormQueue: React.FC<{
  rows: WebFormRow[];
  error?: string | null;
  onChanged: () => void;
}> = ({ rows, error, onChanged }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const empty = rows.length === 0;
  const canApprove = !!selected && (selected.queue_state === "AWAITING_GROK_REVIEW" || selected.queue_state === "GROK_REVIEWED");
  const canReject = !!selected &&
    ["AWAITING_GROK_REVIEW", "GROK_REVIEWED", "APPROVED_FOR_SEND"].includes(selected.queue_state) &&
    reason.trim().length > 0;
  const canSubmit = !!selected &&
    selected.queue_state === "APPROVED_FOR_SEND" &&
    selected.blockers.length === 0 &&
    reference.trim().length > 0 &&
    notes.trim().length > 0;

  async function run(label: string, work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      toast.success(label);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That web form action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" data-testid="web-form-actions">
        <Button
          type="button"
          size="sm"
          disabled={busy || !canApprove}
          title={empty ? WEB_FORM_EMPTY_COPY : undefined}
          onClick={() => run("Form approved. Mark it submitted after you submit it by hand.", async () => {
            if (!selected) return;
            if (selected.queue_state === "AWAITING_GROK_REVIEW") {
              const reviewed = await callHubFn<ReviewBody>("review_handoff_records", {
                batch_id: selected.batch_id,
                decisions: [{ record_id: selected.id, decision: "reviewed" }],
              });
              appliedOrThrow(reviewed, "Could not mark this form reviewed.");
            }
            const approved = await callHubFn<ReviewBody>("approve_handoff_records", {
              batch_id: selected.batch_id,
              decisions: [{
                record_id: selected.id,
                decision: "approve",
                verdict: "PASS",
                reason: "Approved for manual web form submission",
              }],
            });
            appliedOrThrow(approved, "Could not approve this form.");
          })}
        >
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !canReject}
          title={empty ? WEB_FORM_EMPTY_COPY : undefined}
          onClick={() => run("Form rejected.", async () => {
            if (!selected) return;
            const rejected = await callHubFn<ReviewBody>("reject_handoff_records", {
              batch_id: selected.batch_id,
              decisions: [{ record_id: selected.id, decision: "reject", reason: reason.trim() }],
            });
            appliedOrThrow(rejected, "Could not reject this form.");
          })}
        >
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || !canSubmit}
          title={empty ? WEB_FORM_EMPTY_COPY : undefined}
          onClick={() => run("Form marked submitted.", async () => {
            if (!selected) return;
            await callHubFn("mark_manual_form_submitted", {
              handoff_record_id: selected.id,
              evidence: {
                result: "submitted",
                reference: reference.trim(),
                notes: notes.trim(),
                submitted_at: new Date().toISOString(),
              },
            });
          })}
        >
          Mark submitted
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        These actions do not send anything. Mark submitted only after you have submitted the form yourself.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="web-form-reject-reason">Reject reason</Label>
          <Textarea
            id="web-form-reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this form should not go out"
            disabled={busy || empty}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="web-form-reference">Submission reference</Label>
          <Input
            id="web-form-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Confirmation number or page you submitted"
            disabled={busy || !selected || selected.queue_state !== "APPROVED_FOR_SEND"}
          />
          <Label htmlFor="web-form-notes">Submission notes</Label>
          <Textarea
            id="web-form-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What you submitted and where"
            disabled={busy || !selected || selected.queue_state !== "APPROVED_FOR_SEND"}
          />
        </div>
      </div>

      {empty ? (
        <HubEmpty icon={ClipboardList} title="No web forms waiting" description={WEB_FORM_EMPTY_COPY} />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const active = row.id === selectedId;
            return (
              <Card
                key={row.id}
                className={`p-4 bg-card/50 border-border ${active ? "ring-1 ring-primary" : ""}`}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setSelectedId(row.id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{row.playlist_name || "Untitled playlist"}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {row.track_name || "Unknown song"}
                        {row.form_url ? ` · ${row.form_url}` : ""}
                      </p>
                    </div>
                    <Badge variant="secondary">{row.queue_state}</Badge>
                  </div>
                </button>
                {active && row.blockers.length > 0 && (
                  <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                    {row.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
