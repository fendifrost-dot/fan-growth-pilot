/* eslint-disable @typescript-eslint/no-explicit-any */
// In-memory stub of the supabase-js fluent client — just enough surface for the
// Opportunity repository tests. Faithfully models: insert/update/select chains,
// eq/in/gte/lte/ilike filters, single/maybeSingle terminals, thenable await for
// list queries, exact count, the `entity:growth_entities(*)` embed, and the
// unique constraints the dedupe/idempotency tests rely on (23505 on violation).

type Row = Record<string, any>;

interface UniqueSpec {
  // Returns a stable key for a row, or null if the constraint doesn't apply.
  key: (r: Row) => string | null;
}

const UNIQUES: Record<string, UniqueSpec[]> = {
  growth_entities: [
    {
      key: (r) =>
        r.platform && r.platform_external_id
          ? `${String(r.platform).toLowerCase()}|${String(r.platform_external_id).toLowerCase()}`
          : null,
    },
  ],
  growth_opportunities: [{ key: (r) => (r.dedupe_key ? String(r.dedupe_key) : null) }],
  // Matches migration 20260809000000: unique (entity_id, opportunity_id) when an
  // opportunity is present, else unique per entity_id. Models both partial indexes
  // as one key (NULL opportunity_id -> IS NULL match, not "every NULL distinct").
  growth_conversations: [
    {
      key: (r) => (r.entity_id ? `${String(r.entity_id)}|${r.opportunity_id ?? "NULL"}` : null),
    },
  ],
  // Provider idempotency: unique (interaction_type, external_message_id). A NULL
  // external_message_id does not participate (matches Postgres UNIQUE semantics),
  // so multiple proposed touches with no provider id yet never collide.
  growth_interactions: [
    {
      key: (r) =>
        r.external_message_id
          ? `${String(r.interaction_type)}|${String(r.external_message_id)}`
          : null,
    },
    // Proposal-stage idempotency: partial unique on payload->>'idempotency_key'
    // (migration 20260809010000). Absent key -> not enforced.
    {
      key: (r) => {
        const k = (r.payload as { idempotency_key?: string } | undefined)?.idempotency_key;
        return k ? `idem|${String(k)}` : null;
      },
    },
  ],
  growth_relationship_events: [
    {
      key: (r) =>
        r.source || r.source_id
          ? `${r.source ?? ""}|${r.source_id ?? ""}|${r.event_type ?? ""}`
          : null,
    },
  ],
};

let idCounter = 1;
let clock = Date.parse("2026-08-01T00:00:00.000Z");
function nextId(): string {
  return `id-${idCounter++}`;
}
function nowIso(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

export interface StubDb {
  tables: Record<string, Row[]>;
}

export function createStubClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));

  const ensure = (t: string) => (tables[t] ??= []);

  function violatesUnique(table: string, row: Row): boolean {
    const specs = UNIQUES[table] ?? [];
    for (const spec of specs) {
      const k = spec.key(row);
      if (k == null) continue;
      for (const existing of ensure(table)) {
        if (spec.key(existing) === k) return true;
      }
    }
    return false;
  }

  class Builder {
    private op: "select" | "insert" | "update" = "select";
    private payload: any = null;
    private filters: Array<{ kind: string; col: string; val: any }> = [];
    private selectCols = "*";
    private wantCount = false;
    private orderCol: string | null = null;
    private orderAsc = true;
    private rangeFrom = 0;
    private rangeTo = Infinity;

    constructor(private table: string) {}

    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.payload = rows;
      return this;
    }
    update(patch: Row) {
      this.op = "update";
      this.payload = patch;
      return this;
    }
    select(cols = "*", opts?: { count?: string }) {
      this.selectCols = cols;
      if (opts?.count) this.wantCount = true;
      return this;
    }
    eq(col: string, val: any) { this.filters.push({ kind: "eq", col, val }); return this; }
    in(col: string, val: any[]) { this.filters.push({ kind: "in", col, val }); return this; }
    gte(col: string, val: any) { this.filters.push({ kind: "gte", col, val }); return this; }
    lte(col: string, val: any) { this.filters.push({ kind: "lte", col, val }); return this; }
    ilike(col: string, val: any) { this.filters.push({ kind: "ilike", col, val }); return this; }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderCol = col;
      this.orderAsc = opts?.ascending !== false;
      return this;
    }
    range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this; }

    private matches(r: Row): boolean {
      return this.filters.every((f) => {
        const cell = r[f.col];
        switch (f.kind) {
          case "eq": return cell === f.val;
          case "in": return (f.val as any[]).includes(cell);
          case "gte": return cell != null && Number(cell) >= Number(f.val);
          case "lte": return cell != null && Number(cell) <= Number(f.val);
          case "ilike": {
            const pat = String(f.val).replace(/%/g, "").toLowerCase();
            return String(cell ?? "").toLowerCase().includes(pat);
          }
          default: return true;
        }
      });
    }

    private embed(rows: Row[]): Row[] {
      if (!this.selectCols.includes("entity:growth_entities")) return rows;
      return rows.map((r) => ({
        ...r,
        entity: ensure("growth_entities").find((e) => e.id === r.entity_id) ?? null,
      }));
    }

    private run(): { data: any; error: any; count: number | null } {
      const table = ensure(this.table);
      if (this.op === "insert") {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted: Row[] = [];
        for (const raw of list) {
          const row: Row = {
            id: raw.id ?? nextId(),
            created_at: nowIso(),
            updated_at: nowIso(),
            ...raw,
          };
          if (this.table === "growth_opportunities") {
            row.status ??= "new";
            row.discovered_at ??= nowIso();
            row.score_overridden ??= false;
          }
          if (violatesUnique(this.table, row)) {
            return { data: null, error: { code: "23505", message: "duplicate key value" }, count: null };
          }
          table.push(row);
          inserted.push(row);
        }
        return { data: this.embed(inserted), error: null, count: inserted.length };
      }

      if (this.op === "update") {
        const hits = table.filter((r) => this.matches(r));
        for (const r of hits) Object.assign(r, this.payload, { updated_at: nowIso() });
        return { data: this.embed(hits), error: null, count: hits.length };
      }

      // select
      let rows = table.filter((r) => this.matches(r));
      if (this.orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = a[this.orderCol!] ?? 0;
          const bv = b[this.orderCol!] ?? 0;
          return this.orderAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
        });
      }
      const count = rows.length;
      if (this.rangeTo !== Infinity) rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
      return { data: this.embed(rows), error: null, count: this.wantCount ? count : null };
    }

    single() {
      const { data, error } = this.run();
      if (error) return Promise.resolve({ data: null, error });
      const arr = Array.isArray(data) ? data : [data];
      return Promise.resolve({ data: arr[0] ?? null, error: arr[0] ? null : { message: "no rows" } });
    }
    maybeSingle() {
      const { data, error } = this.run();
      if (error) return Promise.resolve({ data: null, error });
      const arr = Array.isArray(data) ? data : [data];
      return Promise.resolve({ data: arr[0] ?? null, error: null });
    }
    // Thenable: awaiting the builder (list queries) resolves the full result set.
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      try {
        const { data, error, count } = this.run();
        resolve({ data: Array.isArray(data) ? data : data == null ? [] : [data], error, count });
      } catch (e) {
        if (reject) reject(e);
      }
    }
  }

  const client = {
    from(table: string) {
      return new Builder(table);
    },
    _tables: tables,
  };
  return client;
}
