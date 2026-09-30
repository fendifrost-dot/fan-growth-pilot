
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ACTION_SPEC, authorizeAction } from "./outreach-auth.ts";
import { HANDOFF_ACTIONS } from "./handoff-queues.ts";
Deno.test("pipeline: record-level actions are registered, reads do not grant DNA writes", () => {
 for (const action of ["review_handoff_records","approve_handoff_records","reject_handoff_records"])
  assertEquals(ACTION_SPEC[action].cls, "capability");
 for (const action of ["approve_handoff_records","reject_handoff_records"])
  assertEquals((HANDOFF_ACTIONS as readonly string[]).includes(action),true);
 assertEquals(ACTION_SPEC.get_song_dna,{cls:"capability",capability:"read_playlist_ops",surface:"outreach-write"});
 assertEquals(ACTION_SPEC.create_song_dna_draft,{cls:"capability",capability:"draft_song_dna",surface:"admin-write"});
});
