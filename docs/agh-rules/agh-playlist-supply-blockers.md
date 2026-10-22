# AGH playlist supply blockers (standing, read before discovery)

What is already known to be dead, frozen, or refused, so a run does not rediscover it.
Updated 2026-10-22 from the live Hub.

| Blocker | Scope | Rule |
|---|---|---|
| Soundplate (`play.soundplate.com`) | 309 web-form records at `CLAUDE_BATCH_READY` | Frozen route. Never re-submit, never count as supply. Fendi decision pending on retiring the rows. |
| Host-less web-form packets | 70 records | No form URL survives re-verification. Not supply. |
| `submitlink.io`, `dailyplaylists.com`, `submithub.com` | 0 lifetime approvals, standing CoS freeze | Do not draft. |
| Pay-to-play / blocked operators (`blocked_operator`) | per `operator_group_id` | Refused at intake and at draft. Do not retry with a different handle or email of the same operator. |
| Operator cooldown (`pair_cooldown` / `cooldown_conflict`) | 90 days per curator, all channels, both songs | By design. Report `cooldown_until`; do not re-pitch a sibling playlist of a pitched operator. |
| Structural route rejections (login, paywall, captcha, dead form, follow gate) | same route | Not re-drafted (`prior_structural_rejection`). |
| Route-repair holds (`route_not_verified`, `pending_review_aged`) | 446 old web-form records | Return to Grok only after fresh re-verification evidence; `advance_playlist_batches` skips mixed batches. |
| Catalog duplicates | 44% of evaluations in the last 7 days | The agent's web search surface returns known playlists. New surfaces (Hub Spotify live search, Firecrawl fallback) are a Fendi/Cursor decision. |

Measured yield, last 7 days to 2026-10-22: 409 evaluated, 81 net-new verified eligible
(about 12 per day across both songs) against an objective of 60 drafts per day. A run that
reports `partial` for that reason is reporting the truth, not failing.
