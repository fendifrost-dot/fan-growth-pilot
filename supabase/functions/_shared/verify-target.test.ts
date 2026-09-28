// Deno tests for the pure verification helpers. Run: deno test supabase/functions/_shared/verify-target.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isValidEmailFormat,
  domainOf,
  tld,
  isInvalidTld,
  domainCandidates,
  isDraftable,
  normalizeEmail,
  lookupMx,
} from "./verify-target.ts";

Deno.test("isValidEmailFormat accepts normal addresses", () => {
  assertEquals(isValidEmailFormat("curator@deephousehq.com"), true);
  assertEquals(isValidEmailFormat("a@b.co"), true);
});

Deno.test("isValidEmailFormat rejects malformed addresses", () => {
  assertEquals(isValidEmailFormat("no-at-sign"), false);
  assertEquals(isValidEmailFormat("two@@at.com"), false);
  assertEquals(isValidEmailFormat("space in@local.com"), false);
  assertEquals(isValidEmailFormat("@nolocal.com"), false);
});

Deno.test("isInvalidTld catches synthesized/placeholder TLDs", () => {
  // The real 6/12 offender: submissions+soundplate@noreply.form
  assertEquals(isInvalidTld("noreply.form"), true);
  assertEquals(isInvalidTld("srv1.mail-tester.local"), true);
  assertEquals(isInvalidTld("foo.test"), true);
  assertEquals(isInvalidTld("deephousehq.com"), false);
  assertEquals(isInvalidTld("city.ac.uk"), false); // valid TLD; caught by non_curator list instead
});

Deno.test("domainOf / tld / domainCandidates", () => {
  assertEquals(domainOf("x@city.ac.uk"), "city.ac.uk");
  assertEquals(tld("city.ac.uk"), "uk");
  assertEquals(domainCandidates(domainOf("ernesto@city.ac.uk")!).includes("city.ac.uk"), true);
  assertEquals(domainCandidates(domainOf("ernesto@city.ac.uk")!).includes("ac.uk"), true);
});

Deno.test("normalizeEmail lowercases and trims", () => {
  assertEquals(normalizeEmail("  Curator@Deep.COM "), "curator@deep.com");
});

Deno.test("isDraftable: gate is a no-op until the column exists", () => {
  assertEquals(isDraftable(undefined), true);   // pre-migration → allow
  assertEquals(isDraftable(null), true);
  assertEquals(isDraftable("manually_verified"), true);
  assertEquals(isDraftable("auto_verified"), true);
  assertEquals(isDraftable("unverified"), false);
  assertEquals(isDraftable("rejected"), false);
  assertEquals(isDraftable("bounced"), false);
});

Deno.test("lookupMx: resolver errors are a temporary lookup_failed, not a missing MX", async () => {
  const real = globalThis.fetch;
  const reply = (body: unknown, ok = true) => () => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
  try {
    globalThis.fetch = reply({ Status: 0, Answer: [{ type: 15 }] });
    assertEquals(await lookupMx("label.example"), "present");
    globalThis.fetch = reply({ Status: 3 });
    assertEquals(await lookupMx("nx.example"), "absent");
    globalThis.fetch = reply({ Status: 0, Answer: [{ type: 1 }] });
    assertEquals(await lookupMx("nomx.example"), "absent");
    globalThis.fetch = reply({ Status: 2 }); // SERVFAIL
    assertEquals(await lookupMx("flaky.example"), "lookup_failed");
    globalThis.fetch = reply({}, false);
    assertEquals(await lookupMx("down.example"), "lookup_failed");
    globalThis.fetch = () => Promise.reject(new Error("network"));
    assertEquals(await lookupMx("offline.example"), "lookup_failed");
  } finally {
    globalThis.fetch = real;
  }
});
