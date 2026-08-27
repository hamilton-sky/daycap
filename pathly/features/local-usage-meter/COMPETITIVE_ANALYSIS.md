# Competitive analysis — LiteLLM and the rest

**Researched 2026-08-27.** Evidence for `PRE-B` (demand), which is still open and still blocks
`P4-6` (release). It does not answer that gate — it sharpens it.

---

## The headline: a premise in the brief is wrong

The brief's *"no server, no proxy, no login"* implies a proxy **cannot** see subscription usage.
**It can.**

LiteLLM ships a first-party documented tutorial for exactly this: point Claude Code at the proxy
via `ANTHROPIC_BASE_URL`, set `forward_client_headers_to_llm_api: true`, and Claude Code's own
**OAuth token** is forwarded to Anthropic. It authenticates against the Max/Pro quota, and LiteLLM
logs real model/token/cost against a virtual key.

So a Max subscriber *can* get LiteLLM to budget their Claude Code usage. **We must never claim
otherwise.** The differentiator is **setup cost, not capability.**

Related correction: a proxy can also see subscription rate-limit state.
`anthropic-ratelimit-unified-5h-utilization` / `-7d-*` headers ride on ordinary `/v1/messages`
responses, and a `GET /api/oauth/usage` endpoint exists. Both are in the request path. What is true
is narrower: that surface is **Anthropic-undocumented, OAuth-scope-gated and observably flaky**
(there is an open issue about persistent 429s), whereas we get the same numbers pre-parsed and
stable from Claude Code's *documented* statusline stdin contract. That is a **maintenance-cost**
argument for staying local, not a visibility one.

---

## What LiteLLM does better

| | LiteLLM |
|---|---|
| **Hard enforcement** | In the request path, so `max_budget` genuinely rejects the call |
| Alerting | `threshold_crossed` (85%/95%), `budget_crossed`, `projected_limit_exceeded` — the last projects spend trajectory |
| Governance | per-user / per-team / per-tag budgets, budget fallbacks (downgrade rather than fail) |
| Breadth | 100+ providers behind one spend view |
| Authority | its `model_prices_and_context_window.json` is the ecosystem's canonical pricing table |

## What it costs

Running a proxy process, **a Postgres database** (budgets are unavailable without one), virtual-key
management, and re-pointing each tool's base URL and auth. Plus documented rough edges: 403s via
`ANTHROPIC_BASE_URL` in some contexts, a model-discovery format mismatch on newer Claude Code, and
Codex CLI ignoring `OPENAI_BASE_URL` outright so it needs a custom launcher.

---

## We already depend on LiteLLM

`model_prices_and_context_window.json` is the canonical community pricing table, **and ccusage
consumes it**. Our dollar figures therefore trace back to LiteLLM's data.

Measured 2026-08-27: `ccusage daily --offline` returns **byte-identical** output to a normal run,
and our adapter always passes `--offline`. So the practical posture holds — but note the honest
limit of the claim: P1-9's network gate covers **our** process, not the ccusage child process.
"Nothing leaves the machine" is a statement about `lum`, not about the whole pipeline.

Known inherited failure modes: unrecognised new models, stale cache, and a network fetch for
freshness unless cached.

---

## The one thing we have that a proxy does not

**Zero infrastructure, and no way to break the user's tooling.**

If `lum` fails, someone sees a wrong number. If a proxy you wrote fails, **Claude Code stops
working** — it sits in the critical path of the user's primary tool, holding their OAuth token.
That asymmetry is the product.

And since the guard landed (PR #7), the gap that justified a proxy is closed: `PreToolUse` gives
hard enforcement for one `settings.json` entry instead of a server and a database.

---

## Honest verdict

**Not a duplicate. But the moat is narrower than the brief claims.**

The niche is real — a solo developer on a subscription who will not stand up Postgres to discover
they burnt their weekly limit on Tuesday. It is also thin. LiteLLM proves people want budget
control; nobody has shown they want it badly enough to *prefer* zero-setup. The ccusage maintainer
closed two requests for precisely this feature as `NOT_PLANNED`, and the strongest demand signal
found anywhere was a single thumbs-up.

**Recommended positioning change:** stop implying uniqueness, claim *zero-setup*. Say plainly that
we warn and enforce **locally**, and that a proxy is the alternative for anyone who wants
provider-side control and is willing to operate one.

---

## Adjacent tools

| Tool | Relation |
|---|---|
| **Helicone** | Same in-path proxy architecture; reportedly in maintenance mode after an acquisition |
| **Langfuse** | Observability via SDK instrumentation or proxy — not a passive local reader |
| **Portkey** | Gateway/proxy; observability is one feature among routing and governance |
| **OpenMeter** | Metering infrastructure for billing, not a CLI-transcript reader |
| **ccusage ecosystem** | At least one tool already combines ccusage + LiteLLM pricing into a dashboard. The "read local transcripts, price via LiteLLM's table" pattern is **not unprecedented** — what was not found is a *budget guardrail with proactive alerting*, as opposed to a dashboard |

That last row is the closest thing to a demand signal we have, and it cuts both ways: the category
exists, and nobody has built our specific thing in it.
