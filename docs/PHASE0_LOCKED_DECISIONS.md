# Phase 0 — Locked Fendi Decisions (2026-09-02)

**Status:** LOCKED — answers to Cursor’s ten Phase 0 questions.  
**Authority:** Fendi Frost (approver) · Grok Chief of Staff (requirements)  
**Repo:** `fendifrost-dot/fan-growth-pilot`  
**Do not invent** music facts, licenses, contacts, fees, or approvals from this file.

---

## 1. AGH-001 remediation — YES (apply before Phase 1)

Apply the forward-only migration `20260828000000_agh001_truth_drift_remediation.sql` before Phase 1 Song DNA work. Preserve incident evidence (do not edit or re-run `20260827000000` / `20260719000000`).

### Pre-apply capture (live DB, project `vsemrziqxrrfcquxfnwd`, 2026-09-01)

| Track | outreach_eligibility | eligibility_source | eligibility_si_version | Categories |
|-------|----------------------|--------------------|------------------------|------------|
| Meditate | eligible | (stale house provenance from uncorrected P0-A apply) | `si-2026-07-19-category-backfill` | `rap_general`, `rap_trap_hype` |
| Designed For Me (Control) | eligible | migration / artist_review path | `si-2026-07-19-category-backfill` | `deep_house_groove`, `house_club`, `house_general`, **`rap_general` (contaminant)** |

Eligible track count pre-apply: **2**.

### Post-apply verification (2026-09-02)

| Track | eligibility_source | eligibility_si_version | Categories |
|-------|--------------------|------------------------|------------|
| Meditate | `artist_review_rap_correction_2026-08-27` | `si-2026-08-27-meditate-rap-correction` | `rap_general`, `rap_trap_hype` |
| Designed For Me (Control) | `artist_review_2026-08-27` | `si-2026-08-28-dfm-category-decontamination` | `deep_house_groove`, `house_club`, `house_general` (no `rap_general`) |

Eligible track count post-apply: **2** (unchanged). Incident evidence in prior migrations retained unedited.

---

## 2. Control curator cooldown

**Rule:** Exact **same-track / same-target** hard block for Designed For Me (Control) through **2026-09-14** (inclusive end of day America/Chicago).

- Track UUID: `5d09da7e-98cf-4276-8dca-861d1fbbfa98`
- New Control targets (never pitched for Control) remain allowed.
- Claude must supply affected target records if they are not already in the Hub.
- Enforced in send path by track UUID + `playlist_id` / target identity — not title matching as primary control.

---

## 3. Song DNA backfill

Approved as **drafts only**. Claude may build DNA v1 from existing music files and records. Every song remains `pending_fendi_review` until Fendi approves. No silent auto-approval from migration or Cursor.

---

## 4. Neva Too Much Prada

Remains **sync-blocked**. No license evidence may be invented. Hub must permit private license upload later. Sample status alone never grants sync eligibility.

Track UUID: `dc36a2c5-f07e-40da-a1b4-0c46c67fadd8`

---

## 5. Split-sheet contributors

Build the generator without waiting for contributor data. Actual sheets stay incomplete until legal names, roles, and percentages are entered. Missing data creates an **action item**, not a development block.

---

## 6. Lyrics provider

Do **not** treat “no vendor this cycle” as locked. Authorize:

- Provider-neutral integration + adapter interface
- Limited **one-song** evaluation
- Test **AudioShake** first; **Whisper** as comparison/fallback
- No recurring subscription or larger catalog processing without separate Fendi approval

---

## 7. 680-contact archive

**No import.** Leave untouched until a separate consent and data-quality plan is approved.

---

## 8. `pitch_campaigns` migration

Do **not** apply `20260718010000_pitch_campaigns_phase1.sql` seed section as written (auto-activates MEDITATE + DFM, daily_target 20, reconstructed authority snapshot).

Revised / superseding requirements:

1. Campaigns begin as **drafts**
2. No campaign is automatically activated
3. Activation requires approved Song DNA + **explicit Fendi approval**
4. New sends require a **campaign ID**
5. Historical records labeled **legacy / reconstructed**, never treated as approved snapshots

See `supabase/migrations/20260902000000_pitch_campaigns_activation_gate.sql` and revised comments on the July campaign migrations.

---

## 9. PR #6

Close as superseded only after replacement PR incorporates remaining valid work and reconciles main / branch / live DB. **Do not merge PR #6.**  
Disposition: closed superseded by Phase 0 reconcile PR (migration + tests committed; app already on main via Lovable `4ca597a`).

---

## 10. MEDITATE licensing default

MEDITATE may appear as the **month-one candidate for review**, but UI must state:

> Month-one candidate — not approved for sync submission until Fendi completes DNA, sample, rights, splits, assets, and sync approval.

MEDITATE must **not** be preapproved, automatically pitchable, or preselected in a live send / log action.

---

## Cursor operational boundary (unchanged)

Cursor implements Hub capabilities only. Cursor does **not** send externally, spend, classify music, approve DNA/sample/sync, invent license evidence, or import the 680-contact archive.
