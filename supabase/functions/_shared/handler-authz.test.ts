/**
 * Handler-level authorization tests for draft / approve / send capability gates.
 * Proves credential-backed identity (not x-agh-agent headers) controls approve/send.
 *
 * Run: deno test --allow-env --allow-read supabase/functions/_shared/handler-authz.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runDraftPitch, runApproveDraft } from "./playlist-agent-run.ts";
import type { Actor } from "./outreach-auth.ts";
import { authorizeAction } from "./outreach-auth.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]> = {}): { from: (t: string) => unknown } {
  const from = (table: string) => {
    let rows: Row[] = (tables[table] ?? []).map((r) => ({ ...r }));
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val || String(r[col]) === String(val));
        return chain;
      },
      in: () => chain,
      not: () => chain,
      or: () => chain,
      order: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () =>
        Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "no row" } }),
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => chain,
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return chain;
  };
  return { from };
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test", { headers });
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const done = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  const out = fn();
  if (out && typeof (out as Promise<void>).then === "function") {
    return (out as Promise<void>).finally(done);
  }
  done();
}

const adminUser: Actor = { kind: "user", userId: "admin-1", isAdmin: true };
const fendiUser: Actor = { kind: "user", userId: "fendi-exact", isAdmin: true };

Deno.test("Claude credential can pass draft gate (not blocked at auth)", async () => {
  await withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, async () => {
    const res = await runDraftPitch(
      { track_id: "missing", playlist_id: "missing" },
      stubSb() as never,
      { kind: "claude" },
      req({ "x-claude-agent-secret": "claude-secret" }),
    );
    // Auth passed — failure is data/DNA validation, not 403 capability denial.
    assert(res.status !== 403, JSON.stringify(res.data));
  });
});

Deno.test("Claude credential cannot approve", async () => {
  await withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, async () => {
    const res = await runApproveDraft(
      { draft_id: "d1" },
      stubSb() as never,
      "hub",
      { kind: "claude" },
      req({ "x-claude-agent-secret": "claude-secret" }),
    );
    assertEquals(res.status, 403);
  });
});

Deno.test("Claude credential cannot send (approve+send_immediately)", async () => {
  await withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, async () => {
    const res = await runApproveDraft(
      { draft_id: "d1", send_immediately: true },
      stubSb() as never,
      "hub",
      { kind: "claude" },
      req({ "x-claude-agent-secret": "claude-secret" }),
    );
    assertEquals(res.status, 403);
  });
});

Deno.test("admin JWT + x-agh-agent:grok cannot impersonate Grok for approve", async () => {
  await withEnv({
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
    ARTIST_USER_ID: "fendi-exact",
  }, async () => {
    const res = await runApproveDraft(
      { draft_id: "d1" },
      stubSb() as never,
      "hub",
      adminUser,
      req({ "x-agh-agent": "grok" }),
    );
    assertEquals(res.status, 403);
    assert(
      String((res.data as { error?: string }).error ?? "").toLowerCase().includes("not permitted") ||
        String((res.data as { error?: string }).error ?? "").includes("grok_playlist_control"),
      JSON.stringify(res.data),
    );
  });
});

Deno.test("human admin cannot approve or send", async () => {
  await withEnv({ ARTIST_USER_ID: "fendi-exact" }, async () => {
    const approve = await runApproveDraft(
      { draft_id: "d1" },
      stubSb() as never,
      "hub",
      adminUser,
      req(),
    );
    assertEquals(approve.status, 403);

    const send = await runApproveDraft(
      { draft_id: "d1", send_immediately: true },
      stubSb() as never,
      "hub",
      adminUser,
      req(),
    );
    assertEquals(send.status, 403);
  });
});

Deno.test("scheduler cannot approve or impersonate Grok", async () => {
  await withEnv({
    OUTREACH_SCHEDULER_SECRET: "sched-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
  }, async () => {
    const res = await runApproveDraft(
      { draft_id: "d1" },
      stubSb() as never,
      "hub",
      { kind: "scheduler" },
      req({ "x-agh-agent": "grok", "x-outreach-scheduler-secret": "sched-secret" }),
    );
    assertEquals(res.status, 403);
    assert(
      String((res.data as { error?: string }).error ?? "").includes("scheduler"),
      JSON.stringify(res.data),
    );
  });
});

Deno.test("Grok credential can pass approve gate (auth not denied)", async () => {
  await withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, async () => {
    const res = await runApproveDraft(
      { draft_id: "d1" },
      stubSb({ outreach_drafts: [] }) as never,
      "hub",
      { kind: "grok_playlist_control" },
      req({ "x-grok-playlist-control-secret": "grok-secret" }),
    );
    // Capability allowed — missing draft yields 404, not 403.
    assertEquals(res.status, 404);
  });
});

Deno.test("Fendi can pass approve gate (auth not denied)", async () => {
  await withEnv({ ARTIST_USER_ID: "fendi-exact" }, async () => {
    const res = await runApproveDraft(
      { draft_id: "d1" },
      stubSb({ outreach_drafts: [] }) as never,
      "hub",
      fendiUser,
      req(),
    );
    assertEquals(res.status, 404);
  });
});

Deno.test("missing credentials cannot draft (anonymous denied)", async () => {
  const res = await runDraftPitch(
    { track_id: "t1", playlist_id: "p1" },
    stubSb() as never,
    null,
    req(),
  );
  assertEquals(res.status, 403);
});


function authStubSb(): { auth: { getUser: (t: string) => Promise<{ data: { user: null }; error: Error }> }; from: () => unknown } {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: new Error("no jwt") }),
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return chain;
    },
  };
}

Deno.test("authorizeAction Claude research / verify / categorize / draft allowed", async () => {
  await withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, async () => {
    const headers = { "x-claude-agent-secret": "claude-secret" };
    for (const action of [
      "run_playlist_research",
      "run_playlist_sweep",
      "reconcile_lane_targets",
      "discover_spotify_placements",
      "import_spotify_for_artists_csv",
      "enrich_curator_contacts",
      "verify_targets",
      "set_playlist_categories",
      "draft_pitch",
    ]) {
      const d = await authorizeAction(action, req(headers), authStubSb() as never);
      assert(d.ok, `${action} ${JSON.stringify(d)}`);
    }
  });
});

Deno.test("authorizeAction Claude approve/send/campaign denied", async () => {
  await withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, async () => {
    const headers = { "x-claude-agent-secret": "claude-secret" };
    for (const action of ["approve_draft", "send_campaign", "activate_campaign", "approve_song_dna"]) {
      const d = await authorizeAction(action, req(headers), authStubSb() as never);
      assertEquals(d.ok, false, action);
    }
  });
});

Deno.test("authorizeAction service cannot unrestricted admin writes", async () => {
  await withEnv({ FANFUEL_HUB_KEY: "hub-key" }, async () => {
    const headers = { "x-api-key": "hub-key" };
    const draft = await authorizeAction("draft_pitch", req(headers), authStubSb() as never);
    assert(draft.ok);
    for (const action of ["activate_campaign", "approve_draft", "upsert_smart_link", "approve_song_dna"]) {
      const d = await authorizeAction(action, req(headers), authStubSb() as never);
      assertEquals(d.ok, false, action);
    }
  });
});

Deno.test("authorizeAction unknown action fails closed", async () => {
  const d = await authorizeAction("not_a_real_action", req(), authStubSb() as never);
  assertEquals(d.ok, false);
  assert(!d.ok && d.status === 403);
});

Deno.test("authorizeAction public capture allowlist works without credentials", async () => {
  for (const action of ["list_campaigns", "list_targets", "count_targets"]) {
    const d = await authorizeAction(action, req(), authStubSb() as never);
    assert(d.ok, action);
  }
});
