# `pitches@fendifrost.com` — Gmail spam fix (DNS + send hygiene)

**Verified:** 2026-05-31 via `dig` from dev machine.  
**Zone:** Cloudflare `fendifrost.com`  
**ESP:** Resend (Amazon SES underneath, Return-Path on `send.fendifrost.com`)

---

## Diagnostic snapshot (matches handoff)

| Record | Live state | Verdict |
|--------|------------|---------|
| `TXT fendifrost.com` (apex SPF) | **No answer** | Fix — add apex SPF |
| `TXT send.fendifrost.com` | `v=spf1 include:amazonses.com ~all` | OK — do not change |
| `TXT resend._domainkey.fendifrost.com` | DKIM public key present | OK — do not rotate |
| `TXT _dmarc.fendifrost.com` | `p=quarantine; rua=mailto:dmarc_rua@onsecureserver.net` | Fix — loosen policy + Fendi rua |
| `MX send.fendifrost.com` | `10 feedback-smtp.us-east-1.amazonses.com` | OK — Resend/SES |

Auth on the wire (SPF/DKIM/DMARC for aligned paths) can pass while Gmail still spams due to **policy + reputation + content + self-testing**.

---

## Cloudflare changes (apply in this order)

### 1. Add apex SPF (new record)

| Field | Value |
|-------|--------|
| Type | TXT |
| Name | `@` (apex) |
| Content | `v=spf1 include:amazonses.com ~all` |
| Proxy | DNS only (N/A for TXT) |

Resend’s [Cloudflare guide](https://resend.com/docs/knowledge-base/cloudflare) documents `include:amazonses.com` on the **`send`** subdomain. Apex SPF with the **same include** is the standard fix when the **From** address is `@fendifrost.com` (organizational domain). Resend does not publish a separate apex `_spf.resend.com` in that doc — use `amazonses.com`.

If you later send from other providers at apex, merge into **one** SPF TXT (max 10 DNS lookups).

### 2. Replace DMARC (edit existing `_dmarc` TXT)

| Field | Value |
|-------|--------|
| Type | TXT |
| Name | `_dmarc` |
| Content | `v=DMARC1; p=none; adkim=r; aspf=r; pct=100; rua=mailto:fendifrost@gmail.com; ruf=mailto:fendifrost@gmail.com; fo=1;` |

Changes:
- `p=quarantine` → `p=none` (stop instructing receivers to quarantine while reputation builds)
- `rua`/`ruf` → Fendi’s Gmail (reports were going to GoDaddy placeholder)

**Ramp (after ~30 days of clean sends + reports):** `p=quarantine; pct=25` → `pct=100` → optional `p=reject`.

### 3. Do not change

- `send` MX / TXT SPF (SES)
- `resend._domainkey` DKIM

---

## Code changes (repo)

| Change | File |
|--------|------|
| `Reply-To: fendifrost@gmail.com` (override via `REPLY_TO_EMAIL`) | `_shared/resend-pitch.ts`, `send-pitch-email`, `execute-pitch` |
| Default subject: `Fendi Frost — {track} for {playlist}` (not `Submission:`) | `playlist-agent-run.ts`, `execute-pitch` |
| Plain `text` + `html` on playlist sends | `execute-pitch`, `send-pitch-email` |
| `FROM_EMAIL` default `pitches@fendifrost.com` everywhere | `execute-pitch` (was `submissions@` fallback) |

Redeploy: **`send-pitch-email`**, **`execute-pitch`** after pull.

Edge secrets (optional):

- `REPLY_TO_EMAIL` = `fendifrost@gmail.com` (default if unset)
- `FROM_EMAIL` = `pitches@fendifrost.com`

---

## Operational rules

1. **Do not** test by sending pitches to Fendi’s own Gmail — trains spam bucket.
2. Use [mail-tester.com](https://www.mail-tester.com/) before/after DNS (wait 5–10 min propagation).
3. Warm: a few real curator emails per day first week; avoid batch blasts.
4. DMARC aggregate reports to `fendifrost@gmail.com` within 24–48h after DNS change.

---

## Optional later

- **Cloudflare Email Routing** — forward `pitches@` or `studio@` to Gmail if you want replies on-domain without MX complexity.
- **List-Unsubscribe** header — only if you add a real unsubscribe path for marketing-style mail (not required for 1:1 curator pitches).

---

## Verification commands

```bash
dig TXT fendifrost.com +short
dig TXT send.fendifrost.com +short
dig TXT resend._domainkey.fendifrost.com +short
dig TXT _dmarc.fendifrost.com +short
```

Expected after fix:

```
"v=spf1 include:amazonses.com ~all"          # apex
"v=spf1 include:amazonses.com ~all"          # send (unchanged)
"v=DMARC1; p=none; ... rua=mailto:fendifrost@gmail.com; ..."
```

---

## Success criteria

- mail-tester.com score **≥ 9/10** on pitch template
- Test to a **friend’s** inbox or mail-tester — not self-send
- DMARC reports in Fendi Gmail within 48h
