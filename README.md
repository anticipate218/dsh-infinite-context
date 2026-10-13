# Infinite Context

[@liustack/dsh-infinite-context](https://www.npmjs.com/package/@liustack/dsh-infinite-context) —
a [DeepSeek Harness](https://www.deepseek.com/) host plugin that makes long
sessions survive a fixed-window endpoint.

## Install

```console
$ dsh plugin install @liustack/dsh-infinite-context
```

Or with any DSH version that composes bundle layers manually, add the package
and let its `cordis.patch.yml` mount the plugin entry (see
[Mounting it](#mounting-it-read-this-before-editing) for the full mechanics and
the two rules that make edits actually take effect).

Then configure at least one capacity rule (see [Configuration](#configuration)):

```yaml
rules:
  - provider: modlens-csu
    model: DeepSeek
    contextWindow: 131072     # the REAL upstream budget, measured not guessed
    defaultMaxTokens: 16384
delegation:
  warnRemaining: 0.10
  criticalRemaining: 0.05
  autoSpawn: true
  maxActive: 2
```

## The problem, measured

A real deployment (a proxied vLLM endpoint) enforced **131,072 tokens** for
model `DeepSeek`, while DSH was told the window is **262,144** — twice the real
size. All three numbers below are facts from that deployment, not estimates:

- DSH's own session log recorded `request/context` =
  `{"provider":"modlens-csu","model":"DeepSeek","contextWindow":262144}`.
- Asking the upstream directly settles it. Both sides of the budget enforce the
  same wall:

  ```console
  $ POST /v1/chat/completions {"model":"DeepSeek",...,"max_tokens":200000}
  {"error":{"message":"max_tokens=200000 cannot be greater than
   max_model_len=max_total_tokens=131072. Please request fewer output tokens."}}

  $ POST /v1/chat/completions {"model":"DeepSeek",...}   # ~131065-token prompt
  {"error":{"message":"This model's maximum context length is 131072 tokens.
   However, you requested 8 output tokens and your prompt contains at least
   131065 input tokens, for a total of at least 131073 tokens."}}
  ```

- The billion-context proxy log independently recorded the upstream refusing
  oversized requests, **18 times** across that deployment's sessions:

  > `upstream context overflow (model=DeepSeek) — window 131072 stated upstream;
  > armed emergency shrink, declared window unchanged (#987)`

Because the declared window is 2× the real one, every layer that sizes itself
against it is wrong:

| layer | believes | reality |
| --- | --- | --- |
| DSH `compaction-basic` | fires at ~229K tokens | request is refused long before |
| billion-context | reserves output from 262144, judges prompt against ~257376 | upstream caps the total at 131072 |
| the UI's context meter | reports ~262K headroom | there is only ~131K |

So a session runs straight at a wall it cannot see, and the proxy only reacts
*after* the refusal by arming an emergency shrink. The proxy's own comments call
this out: `declared window unchanged (#987)`.

## What this plugin does

**1. Truthful capacity — the main fix.** It patches
`llm.normalizeModelInfo`, the single funnel behind `resolveModelInfo`,
`prepareCall`, `stream`, and the `request/context` session record, so the route
reports the real window from `rules[]`. It also scales the output reservation to
the real budget, since that reservation is carved *out* of the window.

This is the whole trick: one correction propagates to every consumer at once,
because they all read that one function. Billion-context included — it caches
`info.context.contextWindow` from `llm.resolveModelInfo`, so it re-learns the
real number on its next refresh. Compression then fires on schedule and the
conversation continues inside the budget that actually exists.

**2. Stops the per-step `dsh_compaction_refused` storm — the second real fix.**
On a lane billion-context proxies, it refuses DSH's native compaction with
`403 dsh_compaction_refused`, because a landed DSH checkpoint durably shadows the
raw history bili compresses from. The refusal is correct. What is *not* correct
is that `compaction-basic` retries it on **every single step**: `harness.log`
carried **1,084** byte-identical unexplained warnings across these sessions,
roughly 40 per minute.

The mechanism, read off `dsh-compaction-basic/lib/index.js`:

```js
// resolveCompactSpec
const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio,
                                          pressureBudgetTokens))
// compactIfNeeded
if (measurement.totalTokens < spec.thresholdTokens) return null   // never asks the proxy
```

The engine asks the proxy only once the measured session crosses
`thresholdTokens`. The pressure term can't exceed `headroomTokens` (65536), so
with a 131072 window the threshold lands near 49152 — and a real session is above
that essentially forever. Raising `contextWindow` lifts the `0.8 × window` term
instead, so the engine returns `null` *before* it ever calls the summarizer.

That is a genuine tension, and it is worth stating plainly rather than hiding:
on a bili-owned lane the **raw session surface legitimately exceeds the model
window**, because bili compresses what it *sends* upstream while DSH's meter
counts the raw surface. DSH has no way to express "my surface may exceed my
window, someone downstream compresses it". So this plugin says so on DSH's behalf
— see `proxyOwnedContextWindow` below — while **bili keeps its own real ceiling
untouched** (`compress.modelContextLimit` outranks any client-reported window, so
nothing is actually loosened). Measured A/B: revert the declared window to 131072
and refusals resume within 1.3 s; restore it and they stop. 1,053 historical, 0
after the correction.

**3. Bounded compaction headroom.** `compaction-basic` deducts a fixed
`headroomTokens` (default 65536) from the window. That is reasonable against
262144 but collapses a 131072 window to a ~32K threshold. The plugin caps the
headroom at a share of the smallest configured window.

**4. Overflow recovery (best effort).** If the upstream rejects a request
anyway, the plugin runs one forced compaction and asks the agent loop to retry.
Note this path is *blocked while billion-context owns the lane* — see below.

**5. Pressure-adaptive delegation (v1.2).** As the window runs low, the plugin
switches the session from one big thread to a parent + fresh-context children:

- **ADVISE.** A persistent system-prompt section (registry order `TOOL_SUBAGENT`)
  teaches a context-budget protocol: at ~10% remaining, stop absorbing material
  and push each remaining unit of work into a subagent with a self-contained
  prompt; at ~5%, delegate *first*; keep only child summaries, never
  transcripts. This is the model-driven half — the model decides on its own
  judgment, exactly as requested. The text is static per config so it never
  defeats prompt caching.
- **MEASURE.** An `agent/pre-step` listener measures the live session with the
  top-level `tokenMeter` service against the **rule's truthful window** (never
  the widened proxy-owned one, or a proxy lane would never leave the ok band),
  latches per-session bands, and logs each crossing at `warn`.
- **ACT (optional, off by default).** On the first entry into the critical band
  the plugin spawns up to `maxActive` fresh-context rescue subagents through
  `ctx.subagents.start('spawn', …)` — the same seam the built-in subagent tool
  uses, honored on every lane including a proxy-owned one. The child gets an
  empty window, reads the workspace, finishes the most recent unfinished task,
  and writes results to files. Gated behind `delegation.autoSpawn: true`
  because children consume real quota; the per-session band latch caps it at
  one spawn round.

Bands are fractions of the window still *remaining* and are configurable:

```yaml
delegation:
  warnRemaining: 0.10      # teach + announce at <=10% remaining (default 0.10)
  criticalRemaining: 0.05  # act at <=5% remaining (default 0.05)
  autoSpawn: false         # spawn rescue subagents at the critical band
  maxActive: 2             # rescue children per session, 1..N (default 2)
```

The seams this uses are documented with line-level proof in
[DELEGATION-NOTES.md](DELEGATION-NOTES.md): `ctx.subagents.start`
(dsh-subagent.js:2834), `tokenMeter.measure` (dsh-token-meter.js:641),
`systemPrompt.section` (dsh-system-prompt.js:240), and the
`agent/pre-step` waterfall (dsh-agent-loop.js:911-918). All four are top-level
services, so — unlike `compaction` — they are reachable from this fiber.

## What this plugin deliberately does NOT do

**It cannot make the server accept more than 131,072 tokens.** No client-side
plugin can. "Infinite context" here means the session keeps working *inside* the
real budget by compressing on time — not that the wall moves.

**It does not fight billion-context.** The two compose: bili owns compression on
the proxied lane, and this plugin's job is to give bili (and DSH) a truthful
number to compress against. Flipping `allowDshCompaction` to `true` to "fix" the
403 warnings would be a mistake: it would let DSH shadow the very history bili
compresses from, breaking the proxy's substrate.

## Mounting it (read this before editing)

The bundle layer did **not** compose this package into `cordis.yml` (0 entries,
no error), so the working mount is the **profile patch layer**, which reloads
live. Point it at the installed package:

```yaml
- insert:
    - id: infinite-context-v1                     # see the id rule below
      name: "@liustack/dsh-infinite-context"
      # ... or, for a working copy you are editing locally:
      # name: file:///C:/path/to/infinite-context/index.js?v=1
```

Two rules make edits to a **file:// mount** actually take effect — they do not
apply to a registry package name. Both bit me, so they are worth the space:

1. **Bump the entry `id` AND the URL query together.** `- insert:` dedups by
   entry id, so re-saving the same id silently skips the mount; and Node caches
   ES modules by URL, so the same `name` re-runs the *old* code. Changing only
   one of them produces a silent no-op — no reload, no error. Each edit bumps
   both: `infinite-context-v3` / `index.js?v=3`, then `…-v4` / `?v=4`, …
2. **`warn` is the only reliable diagnostic channel.** `info` never reaches
   `harness.log`; `warn` does, via the `[harness-log]` stderr bridge.

A reload shows up in `harness.log` as the plugin's activation lines
(`module evaluated`, `apply() reached; rules=…`, `delegation advisory section
registered`). If you see the error `bad indentation of a sequence entry`
instead, the patch file's YAML is wrong: `- insert:` at column 0, its child
entry at 4 spaces, that entry's keys at 6.

## Configuration

All tuning lives in the mount entry's `config:` in `cordis.patch.yml`; that layer
survives plugin upgrades. The windows below are kept **truthful** on purpose —
the proxy-owned widening is applied by the plugin at runtime, not by hand.

```yaml
- insert:
    - id: infinite-context
      name: "@liustack/dsh-infinite-context"
      config:
        rules:
          - provider: modlens-csu   # exact id, or a glob: modlens-*, *
            model: DeepSeek         # exact id, or a glob: deepseek-*, *
            contextWindow: 131072   # the REAL total budget (prompt + output)
            defaultMaxTokens: 16384 # output reservation carved from that budget
          - provider: csu
            model: DeepSeek
            contextWindow: 131072
            defaultMaxTokens: 16384
        overflowRecovery:
          enabled: true
          maxRetriesPerTurn: 2
        compactionHeadroomRatio: 0.125
        compactionHeadroom: true
        delegation:
          warnRemaining: 0.10      # teach + announce at <=10% remaining
          criticalRemaining: 0.05  # act at <=5% remaining
          autoSpawn: true          # spawn rescue subagents at the critical band
          maxActive: 2             # rescue children per session
```

| key | meaning |
| --- | --- |
| `rules[].provider` / `rules[].model` | Exact id or `*` glob; first match wins. |
| `rules[].contextWindow` | Total token budget the upstream enforces. **The number everything sizes against.** |
| `rules[].defaultMaxTokens` | Output tokens reserved inside that budget. Defaults to 12.5% of the window. |
| `overflowRecovery.enabled` | Compact-and-retry on a rejected oversized request. |
| `overflowRecovery.maxRetriesPerTurn` | Recovery attempts before the turn may fail. |
| `compactionHeadroomRatio` | Ceiling for `compaction-basic`'s fixed headroom, as a window share. |
| `compactionHeadroom` | Set `false` to leave headroom untouched. |
| `compactionOwnedByProxy` | Force the ownership decision: `true` suppresses native compaction, `false` keeps it. Unset = detected. |
| `proxyOwnedContextWindow` | Window to *report* on a proxy-owned lane. Default `8388608`. `Math.max`-ed with the rule, so a rule is never shrunk. |
| `widenWhenProxyOwned` | Set `false` to report every rule verbatim even on a proxy-owned lane. |
| `delegation.warnRemaining` | Warn band, fraction of the window still *remaining*. Default `0.10`. |
| `delegation.criticalRemaining` | Critical band; clamped to be ≤ `warnRemaining`. Default `0.05`. |
| `delegation.autoSpawn` | Spawn plugin-driven rescue subagents at the critical band. Default `false` (children consume real quota). |
| `delegation.maxActive` | Rescue children per session. Default `2`. |

### The two numbers, and why they differ

`rules[].contextWindow` stays the **truth** the upstream enforces (131072 for
`DeepSeek`). `proxyOwnedContextWindow` is what the plugin **reports to DSH** when
it detects that a reversible-compression proxy owns the lane, so that DSH's
native compaction stops re-attempting a call the proxy refuses every step.

Detection order: `compactionOwnedByProxy` if set → billion-context's own
`dsh.allowDshCompaction` in `billion-context.json` (strongest evidence: it states
who owns compression) → the mere existence of that config file → the
`BILLION_CONTEXT_*` env flags. The env flags are *last* on purpose: the desktop
app does not export them into the plugin host, so they read false on a lane that
is demonstrably proxied.

Because `compress.modelContextLimit` outranks any client-reported window in
billion-context, this widening **cannot** loosen the proxy's real ceiling — it
only silences DSH's redundant native attempt. Keep the proxy's per-model pins in
place (`context` / `output` / `compress.modelContextLimit` per model) so that
stays true for every model you route to.

Two rules are listed per model because `modlens-csu` is a runtime wrapper around
the `csu` provider. Cover both so the correction survives whichever route is
selected.

## Want a genuinely longer context?

This plugin makes DSH honest about the window it already has. It cannot enlarge
the window — no client-side code can. But the **same endpoint serves two models
with twice the room**, verified with the identical probe:

| model | `max_total_tokens` reported upstream |
| --- | --- |
| `DeepSeek` | 131072 |
| `GLM` | **262144** |
| `Qwen` | **262144** |

So if `DeepSeek`'s real 131K is not enough, selecting `GLM` or `Qwen` doubles it
to 262K — which is what DSH *thought* it had all along. The plugin already
carries pinned rules for both, so the numbers stay correct if the catalogue
changes.

Note that `GLM` and `Qwen` are text-only here, and the `modlens-csu` wrapper
only exists for wrappable families — check that the route you pick still has
vision support if you need to send images.

### Choosing the output reservation

The budget is shared, so the split is the main dial. `defaultMaxTokens: 16384`
leaves ~114K tokens of prompt room. Dropping it to `8192` buys ~8K more prompt
room at the cost of shorter answers.

## Compatibility

No Harness package is imported — the service surface is duck-typed, so the
plugin tolerates Harness upgrades. If `llm.normalizeModelInfo` or the
`compaction` service is unavailable, it logs a warning and leaves that mechanism
off rather than throwing. Every registration is an effect and is removed on
unload.

## Verifying it took effect

After a reload, `harness.log` should carry this sequence — these are the real
lines from a working reload, in order:

```
warn root: patch: entry "genui" not found                          # the reload marker
[infinite-context] module evaluated
warn include: infinite-context: a reversible-compression proxy owns this lane,
  so the declared window is raised to 8388608 ...
[infinite-context] installCapacityCorrection: normalizeModelInfo patched
[infinite-context] apply() reached; rules=6; compaction via ctx.get(false) = undefined
warn include: infinite-context: activating; compaction via ctx.get = undefined
[infinite-context] capacity corrected modlens-csu/DeepSeek 131072 -> 8388608
```

Note the last line: the *rule* is 131072 (truth) and the *reported* window is
8388608 (the proxy-owned widening). The absence of `module evaluated` means your
edit did not load — see the id/query rule above.

DSH's own session record confirms propagation. Decoding
`harness/sessions/<workspace>/<session>/session.v4.jsonl.zstd` and reading every
`request/context` payload gives the alternating history:

```
seq=4524 {"provider":"modlens-csu","model":"DeepSeek","contextWindow":131072}
seq=4684 {"provider":"modlens-csu","model":"DeepSeek","contextWindow":8388608}
DISTINCT: [262144, 131072, 1048576, 8388608]   LATEST: 8388608
```

The `262144` at the start is the original 2× overstatement this plugin exists to
correct.

The number to watch on the proxy side is unchanged and must stay unchanged — the
widening is not allowed to loosen it:

```console
$ GET http://127.0.0.1:18787/__bili/stats
{"contextWindow":114688, ...}          # 131072 - 16384 reserve, was 257376
```

Finally, the `dsh_compaction_refused` count should freeze:

```console
# before: ~40 per minute, 1053 total in one session
# after:  0 new occurrences
```

## Honest limits, measured

- **The headroom clamp (mechanism 3) does not reach a live host.** The running
  `compaction-basic` lives inside a preset-isolated `cordis:group`
  (`isolate: {compaction: true}`), so it is invisible from the plugin's fiber:
  `ctx.get('compaction')` is `undefined` and `ctx.inject(['compaction'], cb)`
  never fires. The clamp is exercised by the smoke test and is correct, but it is
  a no-op in production today. Mechanism 2 is what actually stops the storm, and
  it works through `llm.normalizeModelInfo`, which *is* reachable.
- **No profile-layer patch can reach that nested instance either.** A patch row
  targeting `- id: compaction` logs `patch: entry "compaction" not found`, because
  `applyEntryPatches` only recurses into `entry.group && Array.isArray(entry.config)`
  and a preset's children live in `config.plugins`. Verified dead end, not an
  oversight.

## Tests

`node test/smoke.mjs` exercises the real `apply` against a fake cordis context,
a fake `llm` runtime and a fake `compaction` service that refuses the way
billion-context does — 29 assertions, all passing. It covers capacity
correction, glob matching, the proxy-owned widening (including `Math.max`
semantics), compaction reachability both direct and deferred, the headroom clamp,
both ownership paths (decided at activation and learned from a refusal), and
overflow recovery with its retry budget. No Harness install required.

The suite passes `widenWhenProxyOwned: false` wherever it asserts a truthful
window, because it runs on a machine whose live bili config makes the lane
proxy-owned. Without that, the tests would read the host's real configuration and
fail on a correct build.
