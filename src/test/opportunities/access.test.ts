import { describe, it, expect } from "vitest";
import { classifyRoute, decideAccess, parseResource } from "@/lib/opportunities/access";
import type { OppActor } from "@/lib/opportunities/access";

const anon: OppActor = { kind: "anonymous" };
const user: OppActor = { kind: "user", userId: "u1", isAdmin: false };
const admin: OppActor = { kind: "user", userId: "a1", isAdmin: true };

describe("route classification (RLS-sensitive)", () => {
  it("GET is a read; everything else is an admin write", () => {
    expect(classifyRoute("GET", ["opportunities"])).toBe("authenticated-read");
    expect(classifyRoute("POST", ["opportunities"])).toBe("admin-write");
    expect(classifyRoute("PATCH", ["opportunities", "id"])).toBe("admin-write");
    expect(classifyRoute("post", ["opportunities", "id", "approve"])).toBe("admin-write");
  });
});

describe("access decisions", () => {
  it("rejects anonymous on reads AND writes (never anonymous-open)", () => {
    expect(decideAccess("authenticated-read", anon)).toMatchObject({ ok: false, status: 401 });
    expect(decideAccess("admin-write", anon)).toMatchObject({ ok: false, status: 401 });
  });

  it("allows any signed-in user to read", () => {
    expect(decideAccess("authenticated-read", user)).toMatchObject({ ok: true });
    expect(decideAccess("authenticated-read", admin)).toMatchObject({ ok: true });
  });

  it("requires admin for writes — a plain user is 403", () => {
    expect(decideAccess("admin-write", user)).toMatchObject({ ok: false, status: 403 });
    expect(decideAccess("admin-write", admin)).toMatchObject({ ok: true });
  });
});

describe("resource parsing", () => {
  it("strips the function prefix", () => {
    expect(parseResource("/functions/v1/opportunities-api/opportunities/abc/approve")).toEqual([
      "opportunities",
      "abc",
      "approve",
    ]);
    expect(parseResource("/opportunities/stats")).toEqual(["opportunities", "stats"]);
  });
});
