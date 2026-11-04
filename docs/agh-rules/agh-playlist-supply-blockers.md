# AGH playlist supply blockers (standing, read before discovery)

What is already known to be dead, frozen, refused, or productive, so a run does not
rediscover it. Updated 2026-11-04 from the live Hub and the 11-03 / 11-04 Drive run logs.

Read **section 1 first**. The 11-02 claim that "every open-web route-bearing surface is
disqualified" was too strong: open-web *listicles* and aggregator searches are dead; the
playlistlookup genre directory is live and has produced every draft since 11-03.

## 1. Productive surface — spend this before anything else

**`https://playlistlookup.com/genre/<slug>`** prints the top 3 rows of each genre page in
full without an account: Spotify playlist id, first-party curator email or Instagram
handle, curator name, follower count. Every other row shows only the channel type behind a
free account.

| Mechanic | Rule |
|---|---|
| 3 free rows per page | Each genre page is a **one-time yield of at most 3 candidates**. Re-fetching a spent page returns the same 3 rows. |
| Citation | `source_url` must be the exact genre page that **prints that row's handle/email**. Route verification is a server fetch of the cited page; citing a sibling genre page fails `target_classification_unverified`. If a fetch fails on one page, re-cite another page of the same directory that also prints the handle. |
| Fields | `curator_name` and `follower_count` are read off the page. Never estimated. |
| Slugs | Use only slugs confirmed against `/genres` (list below). The homepage links 11; `/genres` exposes 54; the site claims 700+. Nine guessed rap/house slugs returned `client_error` on 11-04. **Do not guess slugs.** |
| Free tier ceiling | 3 rows × ~24 fitting slugs ≈ 70 lifetime free candidates, most already spent. The free surface **cannot reach 60 drafts/day**. The 7,563 house / 1,703 hip-hop contacts behind the free account are an **open Fendi decision** (no agent may register an account without it). |

**Verified slugs (54, confirmed against `/genres` 2026-11-04):**

- Rap-side (7): `hip-hop`, `trap`, `drill`, `uk-drill`, `boom-bap`, `grime`, `phonk`
- House / electronic: `house`, `deep-house`, `tech-house`, `melodic-house`,
  `progressive-house`, `afro-house`, `melodic-techno`, `techno`, `electronic`, `edm`,
  `trance`, `dubstep`, `dnb`, `garage`, `synthwave`, `ambient`, `ambient-sleep`
- Other: `chill`, `chill-vibes`, `chillhop`, `lofi`, `pop`, `indie`, `indie-pop`,
  `indie-rock`, `alternative-rock`, `rock`, `punk`, `metal`, `soul`, `neo-soul`, `r-and-b`,
  `jazz`, `folk`, `acoustic`, `country`, `latin`, `reggaeton`, `dancehall`, `afrobeats`,
  `amapiano`, `summer`, `lounge`, `peaceful-piano`, `dream-pop`, `bedroom-pop`, `synth-pop`

**Slugs that do not exist (404 / `client_error`, 11-04):** `rap`, `uk-rap`,
`conscious-hip-hop`, `underground-hip-hop`, `west-coast-hip-hop`, `gangster-rap`,
`organic-house`, `disco-house`, `soulful-house`, `lofi-hip-hop`.

**Pages already spent (fetched / drafted):**

| Page | Date | Yield | Note |
|---|---|---|---|
| `/genre/house` | 11-03 | 3 / 3 | DFM |
| `/genre/afro-house` | 11-03 | 3 / 3 | DFM |
| `/genre/melodic-house` | 11-03 | 3 / 3 | DFM |
| `/genre/tech-house` | 11-03 | 2 / 2 | DFM |
| `/genre/hip-hop` | 11-03, 11-04 | 3 / 2 | Same 3 rows on 11-04: 2 drafted, 1 (TRAP BRASIL) prior structural rejection |
| `/genre/boom-bap` + `/genre/drill` | 11-03 | 3 / 2 | Meditate |
| `/genre/trap` | 11-03 | 1 / 1 | Meditate |
| `/genre/deep-house` | 11-04 | 3 / 3 | DFM (11-03 failed only on citation; see Citation rule) |
| `/genre/progressive-house` | 11-04 | 3 / 2 | DFM; 3rd row is an operator sibling (section 5) |
| `/genre/grime` | 11-04 | 3 / 3 | Meditate |
| `/genre/uk-drill` | 11-04 | 3 / 0 | Same 3 rows as `/genre/grime` |
| `/genre/amapiano` | 11-04 | 3 / 0 | 2 already drafted, 1 incompatible (Lofi Girl piano) |
| `/genre/garage` | 11-04 | 2 / 0 | 2 live routes found, held back as weak fit (section 5) |

**Unspent, in priority order (as of 11-04):**

- Meditate (priority 1): `/genre/phonk`; then re-check `/genre/trap`, `/genre/drill`,
  `/genre/uk-drill`, `/genre/boom-bap` for row rotation. Only 7 rap slugs exist and 5 are
  spent — rap-side supply is the tighter constraint.
- Designed For Me: `/genre/garage` (2 rows identified, Fendi decision in section 5),
  `/genre/melodic-techno`, `/genre/electronic`, `/genre/edm`, `/genre/techno`,
  `/genre/trance`, `/genre/dnb`.

A run that closes `partial` on supply **must have spent the unspent slugs above first**, or
say in `shortfall_reason` why it could not.

## 2. Pools and surfaces that are dead — do not re-spend

| Blocker | Scope | Rule |
|---|---|---|
| **`manually_verified` re-verify pool** (`get_playlist_discovery_work.manually_verified_supply`) | 68 rows | **Skip it.** Five consecutive runs (10-31 → 11-04), 0 drafts, ~37 wasted raw evaluations per run. Causes: 129 of its song–playlist pairs sit on lapsed pitch cooldowns that the server stranded as `existing_pair_already_pitched` duplicates (fix **CODED**, see section 3); ~18 rows are press / label / show entities (`b3_*`, `curator_*`, `label_*`, `show_*`, `soundcloud:*`) that are not playlists; 7 rows carry a mis-assigned stored lane (section 3). Re-test with **one page** after `mcp-playlist-discovery` is redeployed with the cooldown fix; if that page still yields 0 drafts, leave the pool alone and say so. |
| Soundplate (`play.soundplate.com`) | 309 web-form records at `CLAUDE_BATCH_READY` | Frozen route. Never re-submit, never count as supply. Fendi decision pending on retiring the rows (186 Meditate + 207 DFM). |
| Host-less web-form packets | 70 records | No form URL survives re-verification. Not supply. |
| `submitlink.io`, `dailyplaylists.com`, `submithub.com` (alias `sbmt.to`), `soundplate` | 0 lifetime approvals, standing CoS freeze | Do not draft. Ignore an `sbmt.to` link printed on a directory row; use the first-party handle instead. |
| Open-web listicles | `artistrack.com`, `droptrack.com`, `chartlex.com`, `jscalco.com`, `rexiusrecords.com` curator lists | 0 first-party routes between them; they name only frozen or paid platforms. iMusician's hip-hop list has real ids but every route is structurally dead (follow gates, dead Google Form, paid login). Permanent. |
| Aggregator / negative-filtered WebSearch shapes | `"<genre> playlist curator submit your music email"` and `"send your music" OR "demo submissions" -submithub -soundplate …` | 39 results, 0 routes on 11-04. Retire the query shapes, keep the tool. The negative filter collapses onto `community.spotify.com` threads. |
| `deepershades.net/submit-your-demo.html` | one first-party curator | Closed submissions; retry **2026-12-04**, not a blacklist. |
| `isitagoodplaylist.com/top-playlists/deep-house` (and `/south-african-deep-house`) | untested directory | Temporary `client_error` 11-04. **Retry next run** before any aggregator query. |
| `community.spotify.com` Music Exchange threads | curator-posted playlist links, no email/form | On email they refuse `route_only_email_not_drafted`. Viable only if an IG/in-thread route can be derived — Fendi/Cursor ruling pending; do not action. |
| Pay-to-play / blocked operators (`blocked_operator`) | per `operator_group_id`; includes `techmehome`, `dropunited`, `dailydosamusic` (added 11-03) | Refused at intake and at draft. Do not retry with a different handle or email of the same operator. |
| Operator cooldown (`pair_cooldown`, `cooldown_conflict`) | 90 days per curator, all channels, both songs | By design. Report `cooldown_until` / `retry_after`; do not re-pitch a sibling playlist of a pitched operator. Known cooling until 2026-11-22: `3qKNkgJrFpCRleTD0qZGSC`, `0czSeyVyVZoYv0x44nu4K3`, `3JlmwHsilEdmIsZHdAqwVV`; until 2026-11-27: `5wvhQwlEYjBYyzVHDQV5GL`; until 2026-12-11: `2rwIoo35NITJ4VeWkdtwBU`, `4hfPP7BZZHffHvk2ej4SET`. |
| Structural route rejections (login, paywall, captcha, dead form, follow gate) | same route | Not re-drafted (`prior_structural_rejection`). Known: `5CsNWrVNnpJzqVzmxfFXDT` (dailyplaylists login + paid), `spotify:49zsXPRUYaczLjv1KQqdyq` (toneden follow gate), `2O1NjpfM3A4tj9QyfnUF95` (dead Google Form), `spotify:5ipann53YCKfJxrXPmDKHI` (page has no form). |
| Route-repair holds (`route_not_verified`, `pending_review_aged`, `target_inactive`) | 446 old web-form records | Return to Grok only after fresh re-verification evidence; `advance_playlist_batches` skips mixed batches (`route_hold_unresolved`). |

## 3. Named defects owned by Fendi / Cursor (not something a run can work around)

| Defect | State | What a run sees |
|---|---|---|
| **Expired-cooldown trap.** A pair whose 90-day pitch cooldown lapsed came back `existing_pair_already_pitched` with a past `cooldown_until` and was dropped as a duplicate, so pitched pairs never re-entered eligibility. 196 pairs in the Hub are in that state (oldest lapsed 2026-08-28). | **CODED** — `docs/HANDOFF_PLAYLIST_COOLDOWN_RELEASE_2026-11-04.md`. **LIVE only after `mcp-playlist-discovery` is redeployed.** | After redeploy: lapsed pairs classify `existing_verified_eligible` with a `prior_pitch` block; cooling pairs are `deferred` (`pair_cooldown`, `retry_after`). Before redeploy: a duplicate with a past `cooldown_until` is this bug, not exhausted supply — report it as such. |
| **verified_eligible overstated draftable supply.** Submit did not apply the per-curator contact policy that `create_playlist_draft_inventory` enforces, so a row was `verified_eligible` and then `policy_deferred_all / cooldown_conflict` at draft (e.g. `3qKNkgJrFpCRleTD0qZGSC` on 11-03 and 11-04). | **CODED**, same handoff. | After redeploy: such rows come back `deferred` with `code: cooldown_conflict`, `classification: existing_policy_deferred`. web_form rows can still refuse at draft on `prior_structural_rejection`; `verified_eligible` is not a promise of draftability on web_form. |
| **Stored-id shapes.** Active catalog keys exist as bare `ID` (1,104), `spotify:ID` (1,027) and non-Spotify synthetic ids (356). The server aliases all three on lookup and (after redeploy) on the pitch-log cooldown lookup too; the live DB shows 0 cross-shape mismatches between `pitch_log` and `playlist_targets`. | Hygiene, not a gate bug. | Submit the bare 22-char id. `identity_alias_collision` means the same playlist is stored under two keys — report it, do not work around it. |
| **Stored catalog lane beats submitted lane.** A `lane` passed in `submit_playlist_candidates` does not correct a mis-assigned `playlist_targets.lane`. | Data repair, open since 10-30. | Meditate refused `dna_excluded_lane` (stored `deep_house_groove`, titles are rap): `1eJGO6UZEiib5G4QZzW8jJ`, `2OrJdHJr6wV5BBUthEu3ic`, `3ztkE1uMRlbqYpSdkLHfsF`. DFM refused `dna_lane_not_approved` (stored sub-lanes): `0p7AjTadocCnTUsf0IeOHP`, `29TeiKpKV7A6j5MPdIhwNG`, `2BrIlwvkjTtiq7XlkIRE6V`, `2q8h2bi5spjCwzcVRAHgYU`. **Do not resubmit these 7 until the lane column (or DFM's approved lanes) is repaired.** |

## 4. Measured yield

- 7 days to 2026-10-22: 409 evaluated, 81 net-new verified eligible (~12/day).
- 2026-11-03 (tranche_first): 71 intake → 21 verified → 17 drafted, all from playlistlookup.
- 2026-11-04 (discovery_begin): 45 raw → 8 verified → 8 drafted, all from playlistlookup; the
  37 re-verify-pool evaluations produced 0.
- `submissions_today` has been 0 on both songs on every run 10-31 → 11-04: the binding
  constraint is downstream (review and send), not discovery volume. A run that reports
  `partial` for that reason is reporting the truth, not failing.

## 5. Judgment calls already made — do not rediscover

| Id | Why not submitted | Status |
|---|---|---|
| `7CwPtQYVmD2ZRKFKmYel27` Progressive House 2025 (Sound Avenue, `info@soundavenue.be`) | Operator sibling of `demo@soundavenue.be` / Deeper Underground `1JJT5mbWmEFKsEjSPpalob`, drafted for DFM 11-03 | Certain cooldown refusal |
| `2JsJE6GnzRIidyvtoFKJ8U` tech house & grooves (`@alandemusic`) | Operator sibling, drafted for DFM 11-03 | Certain cooldown refusal |
| `41TrZuBoO5HGF0Xt970jcK` Speed Garage 2026 (WUGD, `info@wugd.co.uk`, 25,047) | Live route; speed garage is a weak fit for DFM's approved descriptor | **Fendi may overrule** — ready packet |
| `4MpLX5ixFjhjXGC9aQprlA` Bassline & Bass Anthems (PURE Music, `@puremusicofficial`, 7,694) | Live route; bassline is a weak fit for DFM | **Fendi may overrule** — ready packet |
| `1u4F50HA53L3Jwxbnk9IeO` Peaceful Piano (Lofi Girl) | Piano/study, wrong for both songs | Incompatible |
| `0s10CA5UnAZWnIMmlLUbkK`, `4PObDz7Cv29098XX5Nh9f9`, `7i4ieHmhJoYjpUEhfKFbHt`, `4i16tVGSwOtWezY8Hq35Lt` | Instrumental / beats-only against vocal tracks | Incompatible |
| `4OrN6uNggKkMcskuLjZ53x` Türkçe Drill Top; `3lBUYbTbo5pscOgFS3YbdS` TRAP GOSPEL; `2YvRbrbV0KsFqgk6beWUVK` Best Of Johnny Drille; `3BinEmzsOm7tiIJjjYDPwI` Rap Caviar (editorial) | Language-specific, content mismatch, artist-specific, Spotify editorial | Incompatible |

## 6. Open Fendi decisions, in order of supply unlocked

1. Redeploy `mcp-playlist-discovery` so the expired-cooldown release (section 3) goes live —
   196 pairs, the largest recoverable pool in the catalog.
2. The playlistlookup free-account question (section 1) — the only path to 60/day.
3. Stored-lane repair for the 7 ids in section 3.
4. Whether the two weak-fit garage packets in section 5 should be submitted.
5. Soundplate row retirement (186 + 207 records frozen), pending since 10-22.
