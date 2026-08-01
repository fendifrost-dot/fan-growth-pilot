import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Inbox,
  Sparkles,
  X,
} from "lucide-react";
import {
  opportunitiesApi,
  type ListParams,
  type Opportunity,
  type OpportunityStats,
} from "@/lib/opportunitiesApi";
import { canTransition } from "@/lib/opportunities/outcomes";
import type { OpportunityStatus } from "@/lib/opportunities/types";

const PAGE_SIZE = 20;

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "open", label: "Open (default)" },
  { value: "new", label: "New" },
  { value: "reviewing", label: "Reviewing" },
  { value: "approved", label: "Approved" },
  { value: "in_progress", label: "In progress" },
  { value: "contacted", label: "Contacted" },
  { value: "responded", label: "Responded" },
  { value: "converted", label: "Converted" },
  { value: "snoozed", label: "Snoozed" },
  { value: "rejected", label: "Rejected" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All statuses" },
];

const OPEN_STATUSES = ["new", "reviewing", "approved", "in_progress", "contacted", "responded"];

const fmtTime = (s?: number | null) =>
  s == null ? null : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");

/** Score 0..100 -> tailwind text colour. */
function scoreColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 70) return "text-emerald-600";
  if (v >= 45) return "text-amber-600";
  return "text-rose-600";
}

const COMPONENTS: { key: keyof Opportunity; label: string; invert?: boolean }[] = [
  { key: "audience_match_score", label: "Audience" },
  { key: "relationship_score", label: "Relationship" },
  { key: "reach_score", label: "Reach" },
  { key: "response_probability", label: "Response" },
  { key: "conversion_probability", label: "Convert" },
  { key: "lifetime_value_score", label: "Value" },
  { key: "effort_score", label: "Effort", invert: true },
  { key: "risk_score", label: "Risk", invert: true },
];

const ComponentBar: React.FC<{ label: string; value: number | null; invert?: boolean }> = ({
  label,
  value,
  invert,
}) => {
  const v = value == null ? 0 : Math.max(0, Math.min(100, Number(value)));
  // For inverted (effort/risk) a LOW raw value is good — colour on the "good" axis.
  const good = invert ? 100 - v : v;
  const color = good >= 70 ? "bg-emerald-500" : good >= 45 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{value == null ? "—" : Math.round(Number(value))}</span>
      </div>
      <div className="h-1.5 rounded bg-muted overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
};

const OpportunityCard: React.FC<{
  opp: Opportunity;
  busy: boolean;
  onAction: (fn: () => Promise<unknown>, okMsg: string) => void;
  onSaveMessage: (id: string, message: string) => void;
}> = ({ opp, busy, onAction, onSaveMessage }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(opp.generated_message ?? "");
  const [outcomeType, setOutcomeType] = useState("");

  useEffect(() => setDraft(opp.generated_message ?? ""), [opp.generated_message]);

  const entity = opp.entity;
  const clip =
    opp.recommended_start_seconds != null && opp.recommended_end_seconds != null
      ? `${fmtTime(opp.recommended_start_seconds)}–${fmtTime(opp.recommended_end_seconds)}`
      : null;
  const total = opp.score_overridden && opp.manual_score != null ? opp.manual_score : opp.opportunity_score;

  const can = (to: OpportunityStatus) => canTransition(opp.status as OpportunityStatus, to);

  return (
    <Card className="p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {opp.source_platform && (
              <Badge variant="outline" className="text-[10px] uppercase">{opp.source_platform}</Badge>
            )}
            <Badge variant="secondary" className="text-[10px]">{opp.opportunity_type}</Badge>
            {entity?.entity_type && (
              <span className="text-[11px] text-muted-foreground">{entity.entity_type}</span>
            )}
          </div>
          <h3 className="font-medium mt-1 truncate">{opp.title}</h3>
          {entity && (
            <p className="text-xs text-muted-foreground truncate">
              {entity.name}
              {entity.location ? ` · ${entity.location}` : ""}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className={`text-2xl font-bold font-mono ${scoreColor(total)}`}>
            {total == null ? "—" : Math.round(Number(total))}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {opp.score_overridden ? "manual" : "score"}
          </div>
          <Badge className="mt-1" variant={opp.status === "rejected" ? "destructive" : "default"}>
            {opp.status}
          </Badge>
        </div>
      </div>

      {/* Why + evidence */}
      {opp.why_discovered && <p className="text-sm">{opp.why_discovered}</p>}
      {opp.discovery_evidence && Object.keys(opp.discovery_evidence).length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Discovery evidence</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words bg-muted/50 rounded p-2 max-h-40 overflow-auto">
            {JSON.stringify(opp.discovery_evidence, null, 2)}
          </pre>
        </details>
      )}

      {/* Component scores */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {COMPONENTS.map((c) => (
          <ComponentBar key={String(c.key)} label={c.label} value={opp[c.key] as number | null} invert={c.invert} />
        ))}
      </div>

      {/* Recommendation */}
      {(opp.recommended_action || clip || opp.recommended_song_id) && (
        <div className="rounded border bg-muted/30 p-3 text-xs space-y-1">
          {opp.recommended_action && (
            <div><span className="font-medium">Recommended:</span> {opp.recommended_action}</div>
          )}
          {clip && (
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> Suggested clip {clip}
            </div>
          )}
        </div>
      )}

      {/* Generated message */}
      <div className="space-y-2">
        {editing ? (
          <>
            <Textarea rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => { onSaveMessage(opp.id, draft); setEditing(false); }}>
                Save message
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(opp.generated_message ?? ""); setEditing(false); }}>
                Cancel
              </Button>
            </div>
          </>
        ) : opp.generated_message ? (
          <div className="rounded border p-3 text-xs whitespace-pre-wrap bg-background">
            {opp.generated_message}
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onAction(() => opportunitiesApi.generateAction(opp.id), "Draft generated")}
          >
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Generate action
          </Button>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1 border-t">
        {can("approved") && (
          <Button size="sm" disabled={busy}
            onClick={() => onAction(() => opportunitiesApi.approve(opp.id), "Approved")}>
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve
          </Button>
        )}
        {can("rejected") && (
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => onAction(() => opportunitiesApi.reject(opp.id), "Rejected")}>
            <X className="h-3.5 w-3.5 mr-1" /> Reject
          </Button>
        )}
        {can("snoozed") && (
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => {
              const until = new Date(Date.now() + 7 * 864e5).toISOString();
              onAction(() => opportunitiesApi.snooze(opp.id, until), "Snoozed 7 days");
            }}>
            <Clock className="h-3.5 w-3.5 mr-1" /> Snooze
          </Button>
        )}
        {can("contacted") && (
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => onAction(() => opportunitiesApi.setStatus(opp.id, "contacted"), "Marked contacted")}>
            Mark contacted
          </Button>
        )}
        {can("responded") && (
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => onAction(() => opportunitiesApi.setStatus(opp.id, "responded"), "Marked responded")}>
            Response
          </Button>
        )}
        {can("converted") && (
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => onAction(
              () => opportunitiesApi.recordOutcome(opp.id, { outcome_type: "converted", converted: true, response_received: true }),
              "Conversion recorded",
            )}>
            Conversion
          </Button>
        )}
        {opp.source_url && (
          <Button asChild size="sm" variant="ghost">
            <a href={opp.source_url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open source
            </a>
          </Button>
        )}
      </div>

      {/* Record outcome (compact) */}
      <div className="flex items-center gap-2">
        <Select value={outcomeType} onValueChange={setOutcomeType}>
          <SelectTrigger className="h-8 text-xs w-40"><SelectValue placeholder="Record outcome…" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="contacted">Contacted</SelectItem>
            <SelectItem value="responded">Responded</SelectItem>
            <SelectItem value="positive">Positive reply</SelectItem>
            <SelectItem value="negative">Negative reply</SelectItem>
            <SelectItem value="no_response">No response</SelectItem>
            <SelectItem value="converted">Converted</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !outcomeType}
          onClick={() => {
            onAction(
              () => opportunitiesApi.recordOutcome(opp.id, {
                outcome_type: outcomeType,
                response_received: ["responded", "positive", "negative", "converted"].includes(outcomeType),
                converted: outcomeType === "converted",
              }),
              "Outcome recorded",
            );
            setOutcomeType("");
          }}
        >
          Log
        </Button>
      </div>
    </Card>
  );
};

const AdminOpportunities: React.FC = () => {
  const [rows, setRows] = useState<Opportunity[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<OpportunityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);

  const [statusFilter, setStatusFilter] = useState("open");
  const [typeFilter, setTypeFilter] = useState("all");
  const [minScore, setMinScore] = useState("");
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<"score" | "recent">("score");

  const params = useMemo<ListParams>(() => {
    const p: ListParams = { limit: PAGE_SIZE, offset: page * PAGE_SIZE, order };
    if (statusFilter === "open") p.status = OPEN_STATUSES;
    else if (statusFilter !== "all") p.status = [statusFilter];
    if (typeFilter !== "all") p.opportunity_type = typeFilter;
    if (minScore) p.min_score = Number(minScore);
    if (search.trim()) p.search = search.trim();
    return p;
  }, [statusFilter, typeFilter, minScore, search, order, page]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, st] = await Promise.all([
        opportunitiesApi.list(params),
        opportunitiesApi.stats().catch(() => null),
      ]);
      setRows(list.rows);
      setTotal(list.total);
      if (st) setStats(st);
    } catch (e) {
      setError((e as Error).message || "Failed to load opportunities");
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback((fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    fn()
      .then(() => { toast.success(okMsg); return load(); })
      .catch((e) => toast.error((e as Error).message || "Action failed"))
      .finally(() => setBusy(false));
  }, [load]);

  const saveMessage = useCallback((id: string, message: string) => {
    runAction(() => opportunitiesApi.patch(id, { generated_message: message }), "Message saved");
  }, [runAction]);

  const typeOptions = useMemo(() => {
    const set = new Set<string>(Object.keys(stats?.by_type ?? {}));
    rows.forEach((r) => set.add(r.opportunity_type));
    return Array.from(set).sort();
  }, [stats, rows]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Inbox className="h-5 w-5" /> Opportunity Inbox
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Every scored growth opportunity across channels, highest-value first. Review the evidence,
          approve or reject, generate a draft, and record what actually happened — outcomes feed back
          into the score.
        </p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ["Total", stats.total],
            ["New", stats.by_status?.new ?? 0],
            ["Approved", stats.by_status?.approved ?? 0],
            ["Avg score", stats.avg_score ?? "—"],
          ].map(([label, val]) => (
            <Card key={String(label)} className="p-3 text-center">
              <div className="text-xl font-semibold font-mono">{String(val)}</div>
              <div className="text-[11px] text-muted-foreground">{label}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {typeOptions.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Min score</Label>
            <Input className="h-9" type="number" min={0} max={100} value={minScore}
              onChange={(e) => { setMinScore(e.target.value); setPage(0); }} placeholder="0" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Sort</Label>
            <Select value={order} onValueChange={(v) => { setOrder(v as "score" | "recent"); setPage(0); }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="score">Highest score</SelectItem>
                <SelectItem value="recent">Most recent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Search</Label>
            <Input className="h-9" value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Title…" />
          </div>
        </div>
      </Card>

      {/* Error */}
      {error && (
        <Card className="p-5 border-destructive/40 bg-destructive/5">
          <p className="text-sm text-destructive font-medium">Couldn't load opportunities</p>
          <p className="text-xs text-muted-foreground mt-1">{error}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>Retry</Button>
        </Card>
      )}

      {/* Loading */}
      {loading && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-5 h-64 animate-pulse bg-muted/40" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && rows.length === 0 && (
        <Card className="p-8 text-center">
          <Inbox className="h-8 w-8 mx-auto text-muted-foreground" />
          <p className="text-sm font-medium mt-3">No opportunities match these filters</p>
          <p className="text-xs text-muted-foreground mt-1">
            Discovery connectors (Phase 2) populate this inbox. Until then, opportunities can be
            created via the authenticated API. Try widening the status filter to “All”.
          </p>
        </Card>
      )}

      {/* Results */}
      {!loading && !error && rows.length > 0 && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {rows.map((opp) => (
              <OpportunityCard
                key={opp.id}
                opp={opp}
                busy={busy}
                onAction={runAction}
                onSaveMessage={saveMessage}
              />
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-muted-foreground">
              {total} opportunit{total === 1 ? "y" : "ies"} · page {page + 1} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page === 0 || busy}
                onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <ChevronLeft className="h-4 w-4" /> Prev
              </Button>
              <Button size="sm" variant="outline" disabled={page + 1 >= totalPages || busy}
                onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default AdminOpportunities;
