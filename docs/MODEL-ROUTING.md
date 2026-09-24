# Opt-in Ultracode model routing

## Manage the policy

With a global installation, install the companion `opencode2` dispatch once:

```sh
bash scripts/install.sh --global --tui
bash scripts/install-config-cli.sh
```

`opencode2 ultracode-config` opens a guided menu with a live model catalog, search and effort-variant selection. `list` prints a readable policy; `--json` is only for scripts. The scriptable interface also supports:

```sh
opencode2 ultracode-config list
opencode2 ultracode-config explain reviewer strong --at 2026-09-23T16:00:00Z
opencode2 ultracode-config limits set xiaomi/mimo-v2.6-pro 250000 300000
opencode2 ultracode-config tier show strong
opencode2 ultracode-config tier add strong plans xai/grok-4.7#high --group 1 --reserve 15 --weight 5
opencode2 ultracode-config tier add strong payg xiaomi/mimo-v2.6-pro --main-weight 1 --weight 1
opencode2 ultracode-config tier edit strong xai/grok-4.7#high --hours 8-22
opencode2 ultracode-config tier mode strong weighted
opencode2 ultracode-config tier fallback frontier strong
opencode2 ultracode-config tier move strong xai/grok-4.7#high plans 2
opencode2 ultracode-config role set reviewer strong
opencode2 ultracode-config provider set xai 2
opencode2 ultracode-config capacity status
opencode2 ultracode-config --help
```

All writes validate the options, change only the Ultracode plugin entry in `~/.config/opencode/opencode.json`, and back up the prior config to `opencode.json.ultracode-config.bak`. The installed shim itself is backed up as `opencode2.ultracode-config.bak`. To manage a different JSON config, put `--config PATH` before the command. `explain` reads quota data but makes no model call; it simulates one fresh selection, so a live run's rotation or disabled providers may give a different choice. For a weighted tier it prints the eligible pool with each candidate's weight and share, the next SWRR pick (a fresh router's first draw), and the fallback chain when one fired. Plugin edits need an OpenCode service restart when active runs have finished. Project-level `/ultracode set` overlays still take precedence for concurrency, maxAgents, timeoutMs, permissions and per-provider caps.

Ordinary OpenCode sessions and `opencode2 subagent-config` pins are unchanged. Add `routing` to the Ultracode plugin **options** in your OpenCode config to route only workflow children. Without a matching role or an explicit `agent(..., { tier })` / graph-node `tier`, children continue to use their agent pins. Explicit per-call and run model overrides win. Within a tier, `selection` is `"ordered"` (the default, and what an absent key means) or `"weighted"`; a tier may also name a `fallback` tier. All of that is described below. The router does not call an AI model.

On a fresh `routing init <IANA timezone>`, the CLI offers empty `lite`, `standard`, `strong` and `frontier` tiers without assigning any agent to them. Model choices, provider plans and usage sources are always chosen by the user; an empty tier never silently receives somebody else's paid model.

## How a selection is made

`select()` resolves the tier once: an explicit `{ tier }` hint (per call or graph node) wins, otherwise `routing.roles[agent]`. An agent with no mapping and no hint yields the no-model decision `no tier configured; use agent pin`, and the child keeps its pin.

Every candidate then passes deterministic gates, in this order:

- **Catalog and provider liveness** — skipped as `not in live catalog` when the model is not advertised by the running server, as `provider offline` when its provider is disabled, and as `provider quarantined` when the machine-wide breaker (below) knows the provider is quota-dead.
- **`hours`** — a `[start, end)` window in the policy timezone. The end is exclusive and the range may wrap midnight, so `[22, 8]` means 22:00–08:00 local.
- **`blockedWeekdayHours`** — the same shape, applied only Monday–Friday (`weekday peak hours`). Weekends are never blocked.
- **Quota layering** (plans entries consult the feed even without a reserve; PAYG only honors an explicit reserve):
  - **Hard stop — `quota exhausted`:** a feed reporting `remainingPercent: 0` (including providers whose adapter maps `ordinaryUsageAllowed: false` / `spendControlReached` to 100% used) skips the plans candidate unconditionally. A plan the feed reports exhausted is never tried, not even once.
  - **`reservePercent`** (shown as “keep N%” by the CLI) — the provider's remaining quota is read from its feed (`capacityPool` overrides `quotaIDs[provider]`, which defaults to the provider id) and is the **lowest** remaining across that feed's windows. A known remaining at or below the reserve skips the candidate. 1–2% genuinely left still runs unless a reserve says otherwise.
  - **Unknown feed:** omitted `routing.allowUnknownQuota` now means **allow** (default since 2026-09-25) — a missing feed is not evidence of exhaustion, and the old fail-closed default silently locked reserved plans out whenever the feed command was absent, concentrating load on unreserved plans that then died on the very quota the feed would have shown. Set `allowUnknownQuota: false` explicitly to restore fail-closed behavior for reserved candidates. Unknown never overrides a known remaining at or below the reserve, and never overrides a known zero.

With the eligible set in hand, `selection` decides:

- **`ordered`** (default): tier `plans` groups are visited before `payg` groups, groups themselves have strict priority, and inside a group the eligible candidates rotate by least selections, with array order breaking ties. Weights are ignored and the decision carries no `pool`; an old config behaves exactly as before. (`fallbackChain` still appears if the tier falls back.)
- **`weighted`**: group order is flattened and the eligible candidates form two pools (below). The pick is a deterministic smooth weighted round-robin draw, not a random lottery.

If no candidate is eligible, the tier either recurses into its `fallback` tier or throws with every skip reason (`no eligible <tier> model for <role>: ...`). A tier with **zero** configured candidates is the exception: it is a no-op rather than an error (see [Empty tiers](#empty-tiers)).

## Weighted selection & SWRR

Think of each pool member holding a pile of fair-dealer tickets. On every draw:

1. Every member of the pool that is **not** eligible right now is rebased to zero credit. A grounded candidate accumulates nothing and gains no delayed burst when it re-enters — a night-only plan cannot bank a day's worth of tickets and then win the first night draw. (The rebase is skipped when exactly one candidate is eligible, so at most the one draw's worth of credit it held at grounding can survive a gap; it cannot accumulate.)
2. Every eligible candidate's credit increases by its draw weight for this pool.
3. The highest credit wins (ties go to configured array order), then pays back the total eligible weight, `winnerCredit -= totalEligibleWeight`.

When exactly one candidate is eligible it is simply picked and no credit changes.

Because the winner always gives back exactly what the field contributed, no one can run away with the pool. Proportions match the configured weights **exactly at cycle multiples** (draws equal to the eligible total weight) and **converge over any window with a stable eligible set** — they are not required to hit each weight every window. There is no `Math.random`: the credit map is the only state, so a fresh router's first draw is simply the eligible candidate with the largest weight (ties: earliest configured). This is what `explain` reports as the next pick.

Credits are keyed `${tier}|${pool}|${modelPin}`. The same pin in two different tiers — or in the `main` and `fallback` pools of one tier — keeps independent state and is never shared. Because a credit key identifies one pool member, a `weighted` tier rejects the same pin listed twice inside one pool (`routing tier <name> lists <model> twice`), which would otherwise double-count its weight. `ordered` tiers stay permissive: a pin may appear in two groups with different `hours` or `reservePercent` windows, because ordered rotation uses a per-candidate use count and per-group order, both duplicate-safe.

```sh
# weights 15 / 6 / 2 interleave as a, b, a, a, c, a, b, ... and total exactly 15/6/2 over 23 draws
opencode2 ultracode-config tier mode strong weighted
opencode2 ultracode-config tier fallback strong standard   # try standard if strong has nothing eligible
```

## Weights are conditional shares, not spend rates

`weight` is a share **within whichever pool is eligible at that moment**, not a fraction of overall spend. When a gate removes a candidate, the surviving weights renormalize. The two commands show different denominators: `list` prints shares of the **configured** pool (gates not evaluated — a night-only plan still counts toward the midday percentages), while `explain` prints shares of the **eligible** pool at the simulated time, so the two can legitimately differ for the same tier.

There are two pools:

- **MAIN** — eligible `plans` candidates, drawn with `weight` (default `1`), **plus** eligible PAYG candidates that carry `mainWeight`, drawn with `mainWeight`. If the MAIN pool is non-empty it always wins.
- **FALLBACK** — eligible PAYG candidates, drawn with `weight`. Used only when the MAIN pool is empty (no eligible plan **and** no eligible PAYG carrying `mainWeight`).

The mental model: MAIN is the **subscriptions plus occasional paid spice** — a small `mainWeight` lets a metered model take a sliver alongside plans when it is faster or better at something, without letting it dominate. FALLBACK is **pure PAYG**. Because MAIN is considered first, a PAYG candidate **without** `mainWeight` is unreachable while any plan is eligible: it can never be drawn until every plan is gated out. A PAYG candidate may carry both keys (`mainWeight` for MAIN, `weight` for FALLBACK) and competes with different shares in each.

## Tier fallback

`fallback` names another tier to try with the same eligibility machinery when the current tier has no eligible candidate — a “next shelf down” safety net rather than a second lottery. Each hop re-runs the gates against the same clock, catalog and quota, so the reason string shows the whole walk:

```
frontier exhausted -> strong: weighted strong: alibaba-token-plan/qwen3.8-max#medium (w12 of 26)
```

The `fallbackChain` field lists the tiers walked (`["frontier", "strong"]`). Chains may span more than one hop. Validation happens at parse time: `fallback` must reference a defined tier, and self-reference or any cycle is rejected with a walked path (`routing fallback cycle: a -> b -> a`), so a runtime loop is impossible.

Fallback is a **selection-time** decision: it is made before a child is spawned, from hours, quota, catalog and provider state. Post-spawn **provider failover** is a separate path — if the chosen provider dies mid-run, the runtime fails over on the same session through the failover ladder (`opts.fallbacks` > ask-mode run override > `modelFallbacks` > the agent pin pool, disabled by `failover: "off"`). A tier fallback never stands in for that provider failover, and vice versa. A child that was itself routed by a tier normally re-asks the router for the policy's next candidate on failover, but an explicit per-call `fallbacks` list or an ask-mode resume override still wins — an author's or user's explicit choice is never discarded, and only the implicit rungs (the option map and the pin pool) are held back inside the policy. Two shelf rules refine the ladder:

- **Explicit per-call/run models are literal.** A child spawned from `agent(prompt, { model })` or a run-level `model` never takes an implicit substitute: when its provider's quota window closes it *waits for the window* (bounded by the breaker's reset/TTL and a per-call wait budget) and continues the same session on the same model; only a per-call `fallbacks` list, an ask-mode resume override or a `modelFallbacks` entry may replace it. The pin pool and catalog inference are not consulted for such children.
- **Pin-path children keep their own shelf.** A child that neither carried an explicit model nor matched a role mapping fails over through the pin pool with its *own* agent's pin first (a `reviewer` child takes the reviewer pin before any other agent's).


## Worked example: a Hong Kong policy

This is one user's final policy (timezone `Asia/Hong_Kong`, weighted tiers, keep% gates). Edit model ids, effort variants, weights and thresholds to match your catalog and account:

```jsonc
{
  "plugins": [{
    "package": "./plugins/ultracode",
    "options": {
      "providerConcurrency": { "openai": 2, "xai": 2, "alibaba-token-plan": 3 },
      "quotaCommand": ["opencode2", "check-rate", "--json"],
      "childLimits": {
        "xiaomi/mimo-v2.6-pro": { "targetInput": 250000, "hardInput": 300000 },
        "xiaomi/mimo-v2.6-flash": { "targetInput": 250000, "hardInput": 300000 },
        "deepseek/deepseek-flash": { "targetInput": 250000, "hardInput": 300000 },
        "alibaba-token-plan/deepseek-v4.1-flash": { "targetInput": 250000, "hardInput": 300000 }
      },
      "routing": {
        "timezone": "Asia/Hong_Kong",
        "roles": {
          "explore": "standard",
          "general": "standard",
          "sanity": "standard",
          "reviewer": "strong"
        },
        "quotaIDs": { "xai": "xai", "openai": "openai", "alibaba-token-plan": "alibaba-token-plan" },
        "tiers": {
          "lite": {
            "selection": "weighted",
            "plans": [
              [{ "model": "alibaba-token-plan/deepseek-v4.1-flash#low", "hours": [22, 8], "weight": 10 }],
              [{ "model": "openai/gpt-6-luna#none", "weight": 5 }]
            ],
            "payg": [
              [{ "model": "xiaomi/mimo-v2.6-flash", "weight": 5 }],
              [{ "model": "deepseek/deepseek-flash#low", "weight": 3 }]
            ]
          },
          "standard": {
            "selection": "weighted",
            "plans": [
              [{ "model": "alibaba-token-plan/deepseek-v4.1-flash#max", "hours": [22, 8], "weight": 10 }],
              [{ "model": "xai/grok-4.7#medium", "weight": 5 }],
              [{ "model": "openai/gpt-6-luna#xhigh", "reservePercent": 20, "weight": 4 }],
              [{ "model": "openai/gpt-6-luna#high", "weight": 3 }]
            ],
            "payg": [
              [{ "model": "xiaomi/mimo-v2.6-pro", "mainWeight": 1, "weight": 5 }],
              [{ "model": "deepseek/deepseek-flash#high", "weight": 3, "blockedWeekdayHours": [[9, 12], [14, 18]] }]
            ]
          },
          "strong": {
            "selection": "weighted",
            "plans": [
              [{ "model": "alibaba-token-plan/qwen3.8-max#medium", "hours": [22, 8], "reservePercent": 20, "weight": 12 }],
              [{ "model": "xai/grok-4.7#high", "reservePercent": 15, "weight": 5 }],
              [{ "model": "openai/gpt-6-sol#high", "reservePercent": 20, "weight": 5 }],
              [{ "model": "openai/gpt-6-sol#medium", "reservePercent": 8, "weight": 3 }]
            ],
            "payg": [
              [{ "model": "xiaomi/mimo-v2.6-pro", "mainWeight": 1, "weight": 1 }]
            ]
          },
          "frontier": {
            "selection": "weighted",
            "fallback": "strong",
            "plans": [
              [{ "model": "alibaba-token-plan/qwen3.8-max#xhigh", "hours": [22, 8], "reservePercent": 30, "weight": 15 }],
              [{ "model": "openai/gpt-6-astra#medium", "reservePercent": 30, "weight": 1 }],
              [{ "model": "xai/grok-4.7#xhigh", "reservePercent": 25, "weight": 5 }],
              [{ "model": "openai/gpt-6-sol#xhigh", "reservePercent": 30, "weight": 4 }],
              [{ "model": "xai/grok-4.7#high", "reservePercent": 10, "weight": 4 }],
              [{ "model": "openai/gpt-6-sol#high", "reservePercent": 10, "weight": 6 }]
            ],
            "payg": []
          }
        }
      }
    }
  }]
}
```

Notes on this policy:

- **Roles.** `explore`, `general` and a custom `sanity` role sit on `standard`; `reviewer` sits on `strong`. `data-processor`, `ocr` and `deep-researcher` are deliberately left off `roles`, so they stay on their agent pins.
- **`lite` has no role.** It exists for explicit hints (lane extraction and inventory work), so it is reachable only through `{ tier: "lite" }`.
- **Night plan, day plans.** Each tier's Alibaba plan is night-only (`hours: [22, 8]`), so at 02:00 HKT the first `strong` draw is `alibaba-token-plan/qwen3.8-max#medium` (w12 of an eligible 26) and at midday — with the same healthy feed — the pool is `grok-4.7#high` w5, `gpt-6-sol#high` w5, `gpt-6-sol#medium` w3 and `mimo-v2.6-pro` main w1 (14 total).
- **PAYG in MAIN.** `xiaomi/mimo-v2.6-pro` carries `mainWeight: 1` in `standard` and `strong`, so it competes for the last sliver of the MAIN pool while plans are available; its `weight` (5 and 1) is what it gets in the pure-PAYG fallback pool. `frontier` has no PAYG, so when every frontier plan is gated it walks down to `strong`.
- **Weekday blocks.** `deepseek/deepseek-flash#high` is blocked 09:00–12:00 and 14:00–18:00 on weekdays (DeepSeek's published UTC peaks in Hong Kong time); it is always eligible on weekends.
- **Gate interactions are real.** Every `reservePercent` above needs a working quota feed. If a provider's feed is missing, its reserved candidates are skipped, and the effective pool (and the percentages `explain` prints) shrinks. If *every* candidate in a non-empty tier is gated, the tier falls back or throws.

## keep% gates are the deterministic degrade mechanism

`reservePercent` is the one lever that reacts to budget pressure without any nondeterminism:

- A candidate is skipped when the provider's **lowest** reported window is at or below its keep percentage, so a higher-effort or higher-cost carrier can hold a bigger margin. In this policy, `frontier` holds 10–30%, `strong` holds 8–20%, and the cheap night carriers hold less.
- Because the skip happens before the draw, tightening budgets simply renormalize the surviving pool; the same weights still govern who gets picked.
- A cheap carrier on a **weekly-reset** pool can carry no keep (for example `gpt-6-luna#high` has none) so the subscription is used fully before the week resets, while **monthly** pools keep a margin (`alibaba-token-plan/qwen3.8-max` keeps 20–30%) because an overrun there is expensive until month end.
- Keep is per-candidate, so a provider can be fully used at one effort and reserved at another. Setting `allowUnknownQuota: true` lets reserved candidates run while their feed is unknown — it does **not** protect a monthly budget, so prefer a real feed.

Reserves react to the **percentage observed at admission**, not to the predicted spend of in-flight or ordinary sessions. `providerConcurrency` limits Ultracode children, not the main OpenCode session.

## Authoring-time tier hints

Per-call `{ tier }` hints are a workflow-authoring decision, the Claude-Code analog of a lane map. They cost zero runtime tokens (the router makes no AI call) and they are never a lottery. Choose the shelf when you write the workflow — the authoring agent should judge the difficulty of each step and assign its shelf accordingly, exactly like picking a fast model for routine edits and a flagship model for architecture calls:

| Work | Lane | Why |
| --- | --- | --- |
| Lane extraction, inventory, fan-out enumeration, mechanical extraction | `lite` or the default | read-heavy, cheap by construction |
| Merge, gate review, verdict drafting | `strong` | judgment over already-gathered evidence |
| Final judgment, architecture, tie-breaks | `frontier` via explicit `{ tier: "frontier" }` | the expensive shelf, invoked deliberately and rarely |

Because the hint is explicit, a cheap lane can never accidentally spend frontier money, and a frontier step can never silently degrade to a cheap model. Tiers without a role mapping stay reachable this way.

### Difficulty from evidence, not vibes

Most workflows open with the cheap phases anyway — scout, plan, review of the plan — so let them set the shelf for everything after:

- **Discovery.** `ultracode_catalog` caps carry `routing`: the **non-empty (hintable) tiers** and the `roles` map. Authoring models hint only listed tiers (an empty tier fails by design unless it carries a fallback); with no routing configured, hints are inert and should not be emitted.
- **Evidence field.** Give scout/plan/plan-review schemas a `tier` property — an enum of the listed tiers. Later steps interpolate it: graphs use `tier: "{{plan.tier}}"` (exactly one whole-string ref, forward-only like a prompt ref, and a real data edge for wave scheduling); scripts pass `{ tier: plan.data.tier }`. Absent or non-string evidence degrades to the agent's role default rather than poisoning the call.
- **Prior vs instruction.** Before evidence exists, the author's difficulty read is the prior; the user's difficulty instructions in the prompt always win; when unsure, pick the lower shelf unless the step is a final judgment.

Warm replay honours the hint: keyed digests include `tier`, so rerunning with a different hint never replays a result produced on another shelf.

## Onboarding

`routing init <IANA>` writes empty `lite`, `standard`, `strong` and `frontier` tiers and **no** roles: every child keeps its agent pin until the user adds a model and a mapping. Two shapes of install are both served:

- **Bare `general` + `explore` users.** `role defaults` (or the menu path `5. Roles & tiers → Suggest role defaults`, offered right after `init`) proposes the canonical edges: `explore → lite` (read-only codebase search, cheap by construction) and `general → standard` (the default subagent and the agent used by shipped skeletons, including verifier and skeptic phases).
- **Users with many custom roles.** `reviewer → strong` is offered only when a `reviewer` agent is detected (from the live catalog or scanned agent files) unless `--all-known` is passed; `--force` overrides an existing mapping. Custom roles are not guessed — map them explicitly with `role set <agent> <tier>`, and route a phase with a `{ tier }` hint.

`role defaults` writes only agent → tier edges, in one batched write. It never writes a model, hours, reserve or capacity pool. Per-provider specifics — plans vs PAYG, effort variants, weights, `hours`, keep and capacity sources — are always user-chosen in the menu or via `tier add` / `tier edit`. Nothing spends money the user did not pick: a mapped agent whose tier is still empty keeps its pin.

## Empty tiers

A tier with **zero** configured candidates in both `plans` and `payg` still honours its own `fallback`: the router recurses into it with the same eligibility machinery and reports the walked chain (`lite empty -> strong: ...`), so `tier fallback frontier strong` works even before `frontier` has a model.

With no `fallback`, an empty tier degrades only when it is the **requested** tier:

- `select()` returns `{ reason: "tier <name> is empty; use agent pin", skipped: [] }`. A role-mapped agent then keeps its agent pin through the existing primitives path, and an explicit run/call model override still wins.
- An **explicit per-call tier hint** on an empty tier is treated as a caller mistake and throws from `primitives.ts`: `routing tier <name> is empty — configure it or drop the tier hint`. A configured `fallback` supersedes both this error and the pin-degrade: the walk continues into the fallback tier (and returns its model) before either can fire.

An empty tier reached **through a fallback hop** is never a silent pin: an all-gated tier whose fallback is empty is a hard error (`no eligible <tier> model for <role>: ...`), so the pin can never quietly spend the budget the gates were protecting. The `explain` CLI mirrors this: an explicit hint on an empty tier exits non-zero, while a role mapped directly to an empty tier still reports `Selected: agent pin` at exit 0.

Contrast this with a non-empty tier whose candidates are all gated out (hours, keep, catalog, offline provider): that is a hard error with the skip reasons — `no eligible <tier> model for <role>: ...` — unless the tier has a `fallback`. When a fallback fires, the skip reasons from every hop are kept in `skipped`, so a successful walk still records why the earlier tier was gated.

## Capacity feeds

`quotaCommand` is optional and never required by the plugin. The sample adapter accepts `opencode2 check-rate --json` and caches its output for one minute. It reads the lowest remaining percentage across OpenAI's reported five-hour/weekly windows, xAI's weekly pool and Z.ai's reported windows. Alibaba requires the helper's console login and the normalized monthly `raw.monthly.pct` field; without that field its quota is **unknown**, so any candidate with `reservePercent` is skipped. The worked example therefore cannot use Alibaba until that feed is available. `routing.allowUnknownQuota: true` allows unknown-reserve candidates explicitly, but cannot protect a monthly budget. Routing only reserves by *percentage observed at admission*, not by predicted spend of in-flight or ordinary sessions.

### Other users' capacity checkers

`quotaCommand` is a legacy adapter specifically for `opencode2 check-rate`. Other setups can supply named `quotaSources` independently; the checker is called with no model tokens, with no shell interpolation, and should print a single JSON object:

```json
{"pools":[{"id":"team-monthly","windows":[{"remainingPercent":67},{"remainingPercent":24}]}]}
```

The router uses the *lowest* remaining percentage. A checker can optionally include `"status":"ok"` and an ISO `"expiresAt"` on a pool; expired, missing, malformed, or `status: "unknown"` pools stay unknown and reserved candidates are skipped. Configure a named checker and bind one model choice to it through the guided Capacity & usage menu, or use:

```sh
opencode2 ultracode-config capacity source team-monthly capacity-v1 /path/to/my-usage-checker --json
opencode2 ultracode-config capacity bind strong xai/grok-4.7#high team-monthly
opencode2 ultracode-config capacity status team-monthly
```

The candidate's `capacityPool` overrides the legacy provider→quota-id lookup; distinct subscription and PAYG accounts can therefore use distinct capacity pools. The existing `quotaCommand` and `routing.quotaIDs` keep working without migration. Checkers may report multiple windows for shared five-hour, weekly or monthly caps; they own their provider-specific authentication and normalization. Plan/PAYG classifications, hours and reserves remain user-editable choices rather than built-in provider assumptions.

`childLimits` is independent of routing: it applies to named models even if selected through an agent pin. It estimates the assembled request's input from serialized messages, system text and tools, not from cumulative session tokens or the provider's exact tokenizer. At target it removes tools for that model step and injects a sufficiency test: finish in place if the gathered evidence already answers the task, otherwise emit a continuation handoff that starts with a `HANDOFF:` line (original task, findings with evidence, gaps, exact next actions). At hard it refuses the request with a typed message contract — `ultracode context hard limit: …` carrying the estimate, threshold and session id — because the worker bridge serializes errors to their message text. A model response already in flight cannot be stopped by these step-boundary limits, and handoff results require the workflow to explicitly schedule any remaining work (seed the continuation with the original task plus the handoff, and cap the chain — one continuation before surfacing incompleteness).

Two calibration facts. First, the estimate divides serialized UTF-8 bytes by three, which **over-counts real tokens by roughly 25–35%** for English text: a 250,000 target fires at roughly 185–210k real input tokens, and a 300,000 hard at roughly 220–240k. The configured numbers are proxy units — never compare them directly to a provider's context window or token accounting. If runs show frequent `HANDOFF:`s on nearly-finished work, raise `targetInput` a step and keep the ~50k gap to `hardInput` (the gap is the "finish in place" grace zone); resist raising `hardInput` to the model's window — that abandons the discipline, not the safety net. Second, the realistic tripwire is **merge children**, not lanes: eight ~35k-token reports assemble to ~280k. Bound report payloads (ask lane schemas for compact summaries, not echoes) or shrink `batches` when merge children start reporting `HANDOFF:`.
## Machine-wide provider quarantine (2026-09-25)

The per-process `ProviderBreaker` remains authoritative for its own opencode instance, but quota quarantines are now also **published as machine-wide markers** in `~/.local/share/opencode/ultracode/provider-quarantine/<providerID>.json` — beside the provider slot dirs — because users routinely drive several opencode processes in parallel (one per project lane), and on 2026-09-24 four of them each independently re-discovered the same dead xai provider, burning children on it every time.

Contract, in one breath: markers are **advice, not law** — atomic tmp+rename JSON with a bounded `until` (estimated quarantines cap at the 30-minute TTL so a crashed writer can never pin a provider for hours), merged with later-deadline-wins (a provider-*reported* reset may replace an earlier estimate, mirroring the breaker's own rule), pruned on read when expired or malformed, consulted by the router as a distinct `provider quarantined` skip reason and by the failover admission gate. The old concern — "persisting resurrects hours-old strikes after an unrelated plan reset" — is answered by the TTL cap and by markers only ever *adding* a quarantine within that bound; the in-memory breaker stays free to re-probe per its own rules.
