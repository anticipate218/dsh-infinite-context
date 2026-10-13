/**
 * Infinite Context — truthful model capacity plus context-overflow recovery.
 *
 * WHY THIS EXISTS
 *
 * A long session dies at the wall when some layer believes the model window is
 * larger than the upstream actually enforces. Every consumer sizes itself from
 * ONE place, `ctx.llm`'s resolved model metadata:
 *
 *   - `dsh-compaction-basic` reads `info.context.contextWindow` to decide when
 *     to compress and how much to keep.
 *   - `dsh-token-meter` prices the surface against it.
 *   - the agent loop records it as `request/context` (what the UI shows).
 *   - `billion-context` calls `llm.resolveModelInfo(provider, model)` and caches
 *     `info.context.contextWindow` as its own budget, then reserves output tokens
 *     from it. A wrong value mis-sizes the proxy too.
 *
 * When the declared window is too large, proactive compression never fires in
 * time, the request is refused upstream, and the turn ends. When it is honest,
 * every layer above compresses on schedule and the conversation continues
 * indefinitely within the real budget — that is what "infinite context" means
 * on a fixed-window endpoint.
 *
 * HOW IT WORKS
 *
 * Five mechanisms, all reversible:
 *
 *  1. CAPACITY CORRECTION. Patch the LLM runtime's `normalizeModelInfo` — the
 *     single funnel behind `resolveModelInfo`, `prepareCall`, `stream`, and the
 *     `request/context` record — so the routed model reports the real total
 *     budget from `rules[]`. `defaultMaxTokens` is adjusted in the same object
 *     so the output reservation is carved out of the real budget, not a
 *     fictional one.
 *
 *  2. OVERFLOW RECOVERY. Listen on `agent/request-error`. When the upstream
 *     still rejects a request for exceeding the window, run one overflow
 *     compaction and retry the attempt instead of failing the turn.
 *
 *  3. COMPACTION HEADROOM SCALING. See the note above.
 *
 *  4. DELEGATION ADVISORY. A persistent system-prompt section (via the
 *     `systemPrompt` registry, order TOOL_SUBAGENT) teaches the model a
 *     context-budget protocol: at ~10% window remaining it should start pushing
 *     independent work into subagents; at ~5% it should delegate first. This is
 *     the model-driven half — the model decides, on its own judgment, as the
 *     user asked.
 *
 *  5. PRESSURE TELEMETRY + AUTO-DELEGATION. An `agent/pre-step` listener
 *     measures the live session surface with the top-level `tokenMeter` service
 *     against the RULE's truthful window (never the widened proxy-owned one),
 *     latches per-session bands, and logs each crossing. In the critical band
 *     (5% remaining by default) it spawns up to `maxActive` fresh-context
 *     subagents through `ctx.subagents.start('spawn', ...)` — the same seam the
 *     built-in subagent tool uses — so the heavy reading/writing moves out of
 *     the main thread's budget even if the model never acts on the advice.
 *
 * No Harness package is imported. The service surface is duck-typed so this
 * plugin keeps working across Harness upgrades.
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Module-scope activation trace.
 *
 * Written the moment this module is evaluated, before any plugin machinery
 * runs, so it distinguishes "the bundle was never imported" from "the bundle was
 * imported but `apply()` was never called". Log levels cannot make that
 * distinction: `harness.log` carries `warn` lines from other plugins but almost
 * no `info`, so a plugin's own logging is not evidence either way.
 */
const TRACE_FILE = join(homedir(), '.config', 'billion-context', 'infinite-context-trace.log')

function traceModule(line) {
  // stderr is the reliable channel: the harness log records `[stderr]` lines
  // from bundled plugins, while `logger.info` is filtered out almost entirely.
  try {
    process.stderr.write(`[infinite-context] ${line}\n`)
  } catch {
    // Tracing must never affect the plugin.
  }
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Tracing must never affect the plugin.
  }
}

traceModule('module evaluated')

/** Stable error code `dsh-llm` uses for a provider-confirmed window overflow. */
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

/** Fallback recognition for upstreams that report overflow in prose only. */
const OVERFLOW_MESSAGE =
  /(context length|context window|context_length_exceeded|maximum context|too many tokens|reduce the length of the input)/i

/** Default share of the window reserved for output when a rule omits one. */
const DEFAULT_OUTPUT_RESERVE_RATIO = 0.125

/**
 * billion-context refuses DSH's native compaction on a lane it owns, because a
 * landed DSH checkpoint durably shadows the raw history that the proxy
 * compresses from. The refusal is correct, but it surfaces to the user as a bare
 * repeated `403 dsh_compaction_refused` warning with no explanation, so the fix
 * is quoted here once instead of on every turn.
 */
const REFUSAL_MARKER = 'dsh_compaction_refused'

/** Default ceiling for `compaction-basic`'s fixed headroom, as a window share. */
const DEFAULT_COMPACTION_HEADROOM_RATIO = 0.125

/**
 * Delegation bands, as the fraction of the window still REMAINING.
 *
 * `warn` is the nudge: the model is told, in its own system prompt, that the
 * main thread is running out of room and that it should start pushing work into
 * subagents while there is still room to describe the work. `critical` is the
 * point where this plugin stops trusting persuasion and acts on its own.
 */
const DEFAULT_DELEGATE_WARN = 0.1
const DEFAULT_DELEGATE_CRITICAL = 0.05

/** Conservative cap on children this plugin itself spawns at once. */
const DEFAULT_DELEGATE_MAX_ACTIVE = 2

/**
 * Default declared window when a reversible-compression proxy owns the lane.
 *
 * This is not a claim about the model. When billion-context proxies a lane it
 * compresses the conversation reversibly before forwarding it, so the upstream
 * window bounds the COMPRESSED prompt, not the raw session surface that DSH
 * measures. The raw surface legitimately grows far past the model's window —
 * that is the entire point of a reversible-compression proxy.
 *
 * DSH's pressure machinery cannot express that, so it re-attempts a native
 * compaction on every step and pays one `403 dsh_compaction_refused` round-trip
 * each time (measured: ~40/min, 1053 in one session). The preset that mounts
 * `compaction-basic` isolates it in a `cordis:group`, so `auto: false` cannot be
 * patched in from the profile layer. Declaring the window large is therefore the
 * one lever that reaches the live instance: `thresholdTokens` is
 * `min(contextWindow * thresholdRatio, ...)`, so a larger declared window moves
 * the pressure threshold out of reach and the engine returns `null` before it
 * ever calls the summarizer.
 *
 * The real protection is unaffected: billion-context pins its OWN ceiling from
 * its config (`compress.modelContextLimit`), which outranks anything reported
 * here. Verified live: the proxy still logs
 * `effective window 131072 -> 114688 (reserved 16384 for max output)`. This
 * value only silences DSH's redundant native attempt; it does not widen what the
 * upstream will actually accept.
 */
const DEFAULT_PROXY_OWNED_WINDOW = 8388608

/**
 * Create the ownership latch for one activation.
 *
 * `value` is `undefined` until ownership is known, then true when another layer
 * owns compression on this lane. The guard and the overflow handler are
 * established on different fibers and must share one latch, so it is created
 * once per `apply` and threaded to both.
 */
function createOwnershipState() {
  return { value: undefined, reported: false }
}

/** Logger captured at activation, for guidance emitted from helper functions. */
let log = undefined

/**
 * Unconditional activation trace, appended to a plain file.
 *
 * `ctx.logger` output is buffered and filtered before it reaches
 * `harness.log`, so neither `info` nor `warn` proves whether `apply` ran. This
 * trace bypasses the logging pipeline entirely and is the only reliable way to
 * confirm activation from outside the host process.
 */
function trace(line) {
  traceModule(line)
}

/** True when an error is billion-context declining to run DSH native compaction. */
function isCompactionRefusal(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(REFUSAL_MARKER)
}

/**
 * Report billion-context's refusal to run DSH native compaction exactly once.
 *
 * bili owns compression on a lane it proxies, and a landed DSH checkpoint would
 * durably shadow the raw history bili compresses from — so the refusal is
 * correct. What is not helpful is that it surfaces as a bare, repeated
 * `403 dsh_compaction_refused` warning with no explanation, once per step.
 * Quoting the remedy a single time is the whole point.
 */
function reportRefusal(ownership) {
  if (ownership.reported) return
  ownership.reported = true
  log?.warn?.(
    'infinite-context: billion-context owns compression on this lane, so DSH native ' +
      'compaction is suppressed (a landed DSH checkpoint would shadow the history bili ' +
      'compresses from). Compression still happens — bili performs it. This is expected, ' +
      'not a bug. To hand compaction back to DSH instead, set ' +
      '"dsh": { "allowDshCompaction": true } in the bili config or env ' +
      'BILI_ALLOW_DSH_COMPACTION=1 (bili #2028), then reload.',
  )
}

/** Learn from one observed refusal, then stop asking. */
function latchProxyOwnership(ownership) {
  if (ownership.value === true) return
  ownership.value = true
  reportRefusal(ownership)
}

/** True when the operator explicitly asked for DSH compaction to be allowed. */
function allowDshCompactionRequested() {
  const env = typeof process === 'object' ? process.env : undefined
  const flag = env?.BILI_ALLOW_DSH_COMPACTION
  if (typeof flag !== 'string' || flag === '') return undefined
  return flag !== '0' && flag.toLowerCase() !== 'false'
}

/** True when billion-context is mounted in this process. */
function billionContextPresent() {
  const env = typeof process === 'object' ? process.env : undefined
  if (env === undefined) return false
  return Boolean(
    env.BILLION_CONTEXT_NATIVE ??
      env.BILLION_CONTEXT_PLUGIN ??
      env.BILI_NATIVE_DSH ??
      env.BILLION_CONTEXT_PROXY,
  )
}

/**
 * Read billion-context's config file.
 *
 * This is the same file the proxy itself reads, so it is the most reliable
 * evidence that billion-context is configured for this machine — far more so
 * than the environment flags, which the desktop app does not export into the
 * plugin host process (measured: `billionContextPresent()` was false in a live
 * host that was demonstrably proxied by bili).
 *
 * Path resolution mirrors the proxy: `BILI_CONFIG_FILE` wins, else
 * `<XDG_CONFIG_HOME|~/.config>/billion-context/billion-context.json`.
 *
 * @returns the parsed config object, or `undefined` when absent/malformed.
 */
function readBillionContextConfig() {
  const env = typeof process === 'object' ? process.env : undefined
  const explicit = env?.BILI_CONFIG_FILE
  const path =
    typeof explicit === 'string' && explicit !== ''
      ? explicit
      : join(
          env?.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== ''
            ? env.XDG_CONFIG_HOME
            : join(homedir(), '.config'),
          'billion-context',
          'billion-context.json',
        )
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    // A missing or malformed config is normal (bili defaults to refusing), and
    // is not this plugin's problem to report.
    return undefined
  }
}

/**
 * Read billion-context's `dsh.allowDshCompaction` from its config file.
 *
 * @param parsed - an already-read config, to avoid reading the file twice.
 * @returns true/false when the file states an answer, `undefined` otherwise.
 */
function readAllowDshCompaction(parsed) {
  const config = parsed ?? readBillionContextConfig()
  const value = config?.dsh?.allowDshCompaction
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Decide who owns compression on this lane.
 *
 * Ownership only matters when another layer is actually proxying: on a plain
 * DSH setup nothing refuses compaction and the guard is inert. When bili IS
 * present, `allowDshCompaction` (env, then its config file) is authoritative —
 * the env wins over the file exactly as it does inside the proxy.
 *
 * @param configured - the `compactionOwnedByProxy` config override, if any.
 * @returns true, false, or `undefined` when ownership stays unknown.
 */
function resolveProxyOwnership(configured) {
  if (configured === true || configured === false) return configured
  const config = readBillionContextConfig()
  const fromFile = readAllowDshCompaction(config)
  // The proxy's own config file is the strongest available evidence: it exists
  // only because someone configured billion-context on this machine, and it
  // states the exact gate the proxy applies.
  if (fromFile !== undefined) return !fromFile
  if (config !== undefined) return true
  if (!billionContextPresent()) return false
  const requested = allowDshCompactionRequested()
  if (requested !== undefined) return !requested
  return undefined
}

/**
 * Stop paying for refusals.
 *
 * `dsh-compaction-basic` re-runs a proactive compaction on EVERY step
 * (`agent/pre-step` -> `compactIfNeeded(agent, "pressure")`), so on a lane bili
 * owns that is one wasted 403 round-trip per step — hundreds of bare
 * `warn ... dsh_compaction_refused` lines with no explanation. Its own bundle
 * patch sets `auto: false`, but that does not reach the instance a web profile's
 * preset mounts (bili #1772), and `auto` is only read in the constructor anyway,
 * so the listener is already attached by the time this plugin activates.
 *
 * `compactIfNeeded` IS dynamically dispatched, though: replacing it on the
 * service object shadows the prototype method for that live listener. Returning
 * `null` means "nothing to do" — the caller logs nothing and the turn continues
 * — which converts a noisy per-step failure into silence.
 *
 * @param compaction - the live compaction service.
 * @param configured - the `compactionOwnedByProxy` config override, if any.
 * @param ownership - the per-activation latch shared with the overflow handler.
 * @returns a disposer restoring the original method.
 */
function installCompactionGuard(compaction, configured, ownership) {
  if (compaction === null || typeof compaction !== 'object') return undefined

  if (ownership.value === undefined) {
    ownership.value = resolveProxyOwnership(configured)
    // Ownership is proven without spending a request: report the explanation now
    // so the operator is not left guessing why compaction is suppressed.
    if (ownership.value === true) reportRefusal(ownership)
  }

  const original = compaction.compactIfNeeded
  if (typeof original !== 'function') return undefined

  const patched = async function (agent, trigger, signal) {
    if (ownership.value === true && trigger === 'pressure') return null
    try {
      return await original.call(this, agent, trigger, signal)
    } catch (error) {
      if (!isCompactionRefusal(error)) throw error
      // Ownership is now proven. Swallow this refusal rather than rethrowing it
      // into `agent/pre-step`, whose catch is the source of the warnings.
      latchProxyOwnership(ownership)
      return null
    }
  }

  try {
    compaction.compactIfNeeded = patched
  } catch {
    log?.warn?.(
      'infinite-context: could not take over compaction dispatch; refused compactions will keep warning',
    )
    return undefined
  }
  return () => {
    if (compaction.compactIfNeeded === patched) compaction.compactIfNeeded = original
  }
}

/** True when `value` is a usable positive integer. */
function isPositiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Compile one rule field into a matcher. A field is an exact id, or a `*` glob
 * such as `modlens-*` or `*`. Matching is case-insensitive because provider and
 * model ids are written inconsistently across catalogs.
 *
 * @param pattern - rule field, or undefined to match anything.
 * @returns a predicate over a concrete id.
 */
function matcher(pattern) {
  if (pattern === undefined || pattern === null || pattern === '' || pattern === '*') {
    return () => true
  }
  const source = String(pattern)
  if (!source.includes('*')) {
    const exact = source.toLowerCase()
    return (value) => String(value).toLowerCase() === exact
  }
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const re = new RegExp(`^${escaped}$`, 'i')
  return (value) => re.test(String(value))
}

/**
 * Normalize the authored rule list into compiled, first-match-wins rules.
 * Invalid entries are dropped rather than aborting activation, so one typo
 * cannot disable long-context handling for the whole profile.
 *
 * @param raw - the `rules` config array after Loader normalization.
 * @param log - logger used to report dropped entries.
 * @returns compiled rules in declaration order.
 */
function compileRules(raw, log) {
  if (!Array.isArray(raw)) return []
  const compiled = []
  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      log?.warn?.(`infinite-context: rules[${index}] is not an object; ignoring it`)
      return
    }
    if (!isPositiveInt(entry.contextWindow)) {
      log?.warn?.(
        `infinite-context: rules[${index}].contextWindow must be a positive integer; ignoring this rule`,
      )
      return
    }
    const reserve = entry.defaultMaxTokens
    compiled.push({
      label: `rules[${index}]`,
      provider: entry.provider,
      model: entry.model,
      matchProvider: matcher(entry.provider),
      matchModel: matcher(entry.model),
      contextWindow: entry.contextWindow,
      defaultMaxTokens: isPositiveInt(reserve)
        ? reserve
        : Math.max(1, Math.floor(entry.contextWindow * DEFAULT_OUTPUT_RESERVE_RATIO)),
    })
  })
  return compiled
}

/** Resolve the first rule matching one provider/model route. */
function ruleFor(rules, provider, model) {
  for (const rule of rules) {
    if (rule.matchProvider(provider) && rule.matchModel(model)) return rule
  }
  return undefined
}

/** Recognize a provider-confirmed context overflow from an LlmFailure. */
function isOverflowFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false
  if (failure.code === CONTEXT_WINDOW_EXCEEDED) return true
  const message = failure.message
  return typeof message === 'string' && OVERFLOW_MESSAGE.test(message)
}

/**
 * The plugin.
 *
 * `inject` covers the optional collaborators this plugin leans on. `llm` is
 * required for capacity correction; `compaction` only for overflow recovery, so
 * a profile without a compaction backend still gets honest capacities.
 */
export const inject = ['llm']

export const name = 'infinite-context'

export function apply(ctx, config = {}) {
  log = ctx.logger
  const rules = compileRules(config.rules, ctx.logger)
  const overflowConfig =
    config.overflowRecovery !== null && typeof config.overflowRecovery === 'object'
      ? config.overflowRecovery
      : {}
  const overflowEnabled = overflowConfig.enabled !== false
  const maxRetriesPerTurn = isPositiveInt(overflowConfig.maxRetriesPerTurn)
    ? overflowConfig.maxRetriesPerTurn
    : 2
  const compactionHeadroomRatio =
    typeof config.compactionHeadroomRatio === 'number' &&
    config.compactionHeadroomRatio > 0 &&
    config.compactionHeadroomRatio < 1
      ? config.compactionHeadroomRatio
      : DEFAULT_COMPACTION_HEADROOM_RATIO
  const scaleCompactionHeadroom = config.compactionHeadroom !== false

  /**
   * Who owns compression on this lane, resolved ONCE at activation.
   *
   * When a reversible-compression proxy (billion-context) owns it, DSH's raw
   * session surface is deliberately unbounded and the native pressure
   * compaction can only ever be refused — see DEFAULT_PROXY_OWNED_WINDOW. That
   * decision therefore changes what capacity this plugin should report, so it is
   * made here rather than inside the compaction guard.
   */
  const proxyOwnsLane = resolveProxyOwnership(config.compactionOwnedByProxy) === true

  /**
   * Extra headroom, in tokens, added on top of a rule's window when a
   * proxy owns the lane. Configurable so an operator who knows their proxy's
   * real ceiling can pin an exact number; `0` keeps every rule truthful and
   * accepts the per-step refusals.
   */
  const proxyOwnedWindow =
    config.widenWhenProxyOwned === false
      ? undefined
      : isPositiveInt(config.proxyOwnedContextWindow)
        ? config.proxyOwnedContextWindow
        : DEFAULT_PROXY_OWNED_WINDOW

  if (rules.length === 0) {
    ctx.logger?.warn?.(
      'infinite-context: no usable rules configured; model capacities are left untouched',
    )
  }

  if (proxyOwnsLane && proxyOwnedWindow !== undefined) {
    ctx.logger?.warn?.(
      `infinite-context: a reversible-compression proxy owns this lane, so the declared ` +
        `window is raised to ${proxyOwnedWindow} to stop the per-step native compaction that ` +
        `the proxy refuses. The proxy keeps its own real ceiling; set ` +
        `widenWhenProxyOwned: false to keep every rule truthful instead.`,
    )
  }

  /** Provider/model routes whose capacity this plugin corrected at least once. */
  const corrected = new Set()

  /**
   * Correct one normalized model-info record. Returns the input untouched when
   * no rule matches or the declared capacity already equals the real one, so
   * this stays a transparent pass-through for every other route.
   */
  function correctModelInfo(info) {
    if (info === null || typeof info !== 'object') return info
    const provider = info.provider
    const model = info.id
    if (typeof provider !== 'string' || typeof model !== 'string') return info
    const rule = ruleFor(rules, provider, model)
    if (rule === undefined) return info

    const declared = info.context?.contextWindow
    // The rule states the model's REAL capacity. When a reversible-compression
    // proxy owns the lane, DSH's raw surface is deliberately allowed to exceed
    // it (the proxy compresses before forwarding), so widen the number DSH uses
    // for its own bookkeeping while leaving the rule itself truthful.
    const nextWindow =
      proxyOwnsLane && proxyOwnedWindow !== undefined
        ? Math.max(rule.contextWindow, proxyOwnedWindow)
        : rule.contextWindow
    const nextMaxTokens = Math.min(rule.defaultMaxTokens, nextWindow)

    // Only override an output reservation; never invent one for a route that
    // deliberately declares none, since `defaultMaxTokens` means "the adapter
    // chose this", not "some output is allowed".
    const hasReserve = info.defaultMaxTokens !== undefined
    const spec = {
      ...info,
      context: { ...(info.context ?? {}), contextWindow: nextWindow },
      ...(hasReserve ? { defaultMaxTokens: nextMaxTokens } : {}),
    }

    const key = `${provider}/${model}`
    const unchanged =
      declared === nextWindow && (!hasReserve || info.defaultMaxTokens === nextMaxTokens)
    if (!unchanged && !corrected.has(key)) {
      corrected.add(key)
      trace(`capacity corrected ${key} ${declared ?? 'unset'} -> ${nextWindow}`)
      ctx.logger?.info?.(
        `infinite-context: ${key} capacity corrected ${declared ?? 'unset'} -> ${nextWindow}` +
          (spec.defaultMaxTokens === undefined ? '' : `, output reserve -> ${spec.defaultMaxTokens}`),
      )
    }
    return unchanged ? info : spec
  }

  /**
   * Patch the single metadata funnel on the live LLM runtime.
   *
   * `normalizeModelInfo` is the one function every capacity consumer passes
   * through: `resolveModelInfo` (billion-context, compaction pressure),
   * `prepareCall` (the frozen call that records `request/context`), and
   * `stream` (the per-request fallback). Patching it here therefore corrects
   * every consumer at once, with no per-consumer coordination.
   *
   * The method is an own property of the runtime instance in the shipped
   * build, but it is patched on the prototype as well so a build that keeps
   * methods on the class is still covered.
   */
  function installCapacityCorrection(llm) {
    if (llm === null || typeof llm !== 'object') {
      trace('installCapacityCorrection: llm service unavailable')
      return
    }
    const original = llm.normalizeModelInfo
    if (typeof original !== 'function') {
      trace('installCapacityCorrection: normalizeModelInfo is not a function')
      ctx.logger?.warn?.(
        'infinite-context: llm.normalizeModelInfo is unavailable; capacity correction is disabled',
      )
      return
    }
    const patched = function (registration, model, resolved) {
      return correctModelInfo(original.call(this, registration, model, resolved))
    }
    llm.normalizeModelInfo = patched
    trace('installCapacityCorrection: normalizeModelInfo patched')
    return () => {
      if (llm.normalizeModelInfo === patched) llm.normalizeModelInfo = original
    }
  }

  /**
   * Confine `compaction-basic`'s fixed `headroomTokens` to a share of the real
   * window. The engine computes
   * `thresholdTokens = min(contextWindow * thresholdRatio, messageBudget - headroom)`,
   * so an absolute headroom larger than the window's useful remainder collapses
   * the compaction threshold and makes proactive compression unreachably late.
   */
  function installHeadroomClamp(compaction) {
    if (!scaleCompactionHeadroom) return
    const current = compaction?.config
    if (current === null || typeof current !== 'object') return
    const headroom = current.headroomTokens
    if (!isPositiveInt(headroom)) return

    // The engine reads `this.config`, so replacing it with a bounded copy is
    // enough; the original object is captured for the disposer.
    const policies = Array.isArray(current.modelPolicies) ? current.modelPolicies : []
    const smallestWindow = rules.reduce(
      (min, rule) => Math.min(min, rule.contextWindow),
      Number.POSITIVE_INFINITY,
    )
    const ceiling = Number.isFinite(smallestWindow)
      ? Math.max(1, Math.floor(smallestWindow * compactionHeadroomRatio))
      : headroom
    if (headroom <= ceiling) return

    compaction.config = {
      ...current,
      headroomTokens: ceiling,
      maxTokens: current.maxTokens === undefined ? ceiling : Math.min(current.maxTokens, ceiling),
      modelPolicies: policies.map((policy) =>
        policy !== null && typeof policy === 'object' && isPositiveInt(policy.headroomTokens)
          ? { ...policy, headroomTokens: Math.min(policy.headroomTokens, ceiling) }
          : policy,
      ),
    }
    ctx.logger?.info?.(
      `infinite-context: compaction headroom ${headroom} -> ${ceiling} tokens (bounded to ${compactionHeadroomRatio} of the smallest configured window)`,
    )
    return () => {
      compaction.config = current
    }
  }

  // --- 1. capacity correction ------------------------------------------------
  const teardownCorrection = installCapacityCorrection(ctx.get('llm'))
  if (teardownCorrection !== undefined) {
    ctx.effect(() => teardownCorrection, 'infinite-context: model capacity correction')
  }

  // A provider registered later (a plugin activating after this one) keeps the
  // patched prototype, so only re-install if the runtime object itself moved.
  const installedOn = ctx.get('llm')
  ctx.on('llm/adapters-updated', () => {
    const live = ctx.get('llm')
    if (live === installedOn) return
    ctx.logger?.warn?.(
      'infinite-context: the llm runtime was replaced; capacity correction needs a reload to reattach',
    )
  })

  // --- 2 & 3. everything that needs the compaction service -------------------
  //
  // The live compaction service is mounted INSIDE an isolated preset group
  // (`- id: compaction / name: cordis:group / isolate: {compaction: true}` in the
  // preset document), so it is deliberately invisible from this fiber: reading
  // `ctx.get('compaction')` here yields `undefined`, and
  // `ctx.inject(['compaction'], cb)` NEVER fires. That isolation is exactly why
  // an earlier revision's headroom clamp and ownership guard silently did
  // nothing. Both routes are attempted, best-effort, and the overflow handler
  // below is registered on THIS fiber so it works when neither resolves.
  //
  // One ownership latch is created per activation and shared by the guard and
  // the overflow handler, which must agree on the answer.
  const ownership = createOwnershipState()

  // Diagnostic: `info` never reaches harness.log, so the activation summary is
  // emitted at `warn` level while this seam is still being proven in a live host.
  {
    const probe = ctx.get('compaction', false)
    trace(
      `apply() reached; rules=${rules.length}; compaction via ctx.get(false) = ${probe === undefined ? 'undefined' : typeof probe}`,
    )
    log?.warn?.(
      `infinite-context: activating; compaction via ctx.get = ${probe === undefined ? 'undefined' : typeof probe}`,
    )
  }

  let compactionInstalled = false

  /** Install the clamp and the guard on whichever fiber owns the service. */
  function installOnCompaction(ownerCtx, compaction) {
    if (compactionInstalled) return
    if (compaction === null || typeof compaction !== 'object') return
    compactionInstalled = true
    trace('compaction service reached; installing clamp and guard')
    log?.warn?.('infinite-context: compaction service reached; installing clamp and guard')

    // --- 2. bounded compaction headroom -------------------------------------
    const teardownHeadroom = installHeadroomClamp(compaction)
    if (teardownHeadroom !== undefined) {
      ownerCtx.effect(() => teardownHeadroom, 'infinite-context: compaction headroom clamp')
    }

    // --- compaction ownership guard -----------------------------------------
    const teardownGuard = installCompactionGuard(
      compaction,
      config.compactionOwnedByProxy,
      ownership,
    )
    if (teardownGuard !== undefined) {
      ownerCtx.effect(() => teardownGuard, 'infinite-context: compaction ownership guard')
    }
  }

  // Route A: the service happens to be reachable from this fiber right now.
  installOnCompaction(ctx, ctx.get('compaction', false))

  // Route B: it was not reachable yet; wait for its dependency to come up.
  if (!compactionInstalled) {
    ctx.inject(['compaction'], (compactionCtx) => {
      installOnCompaction(compactionCtx, compactionCtx.get('compaction'))
    })
  }

  // --- 3. context-overflow recovery -----------------------------------------
  //
  // `agent/request-error` is a host-wide event, so this listener is registered
  // on the current fiber and works whether or not the compaction service was
  // ever reachable. Its `compaction` lookup inside the handler is itself
  // best-effort, and the proxy-owns branch needs no service at all.
  if (overflowEnabled) {
    registerOverflowRecovery(ctx, maxRetriesPerTurn, ownership)
  }

  // --- 4 & 5. pressure-adaptive delegation ------------------------------------
  //
  // `tokenMeter`, `systemPrompt` and `subagents` are TOP-LEVEL services (the
  // preset isolation that hides `compaction` does not apply to them), so this
  // installs directly on the current fiber with no route dance.
  const delegation = compileDelegation(config.delegation)
  if (delegation.enabled) {
    try {
      installDelegation(ctx, delegation, rules, proxyOwnsLane)
    } catch (error) {
      ctx.logger?.warn?.(
        `infinite-context: delegation could not be installed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Recover a turn whose request the upstream refused for exceeding the window.
 *
 * `agent/request-error` is the only seam that fires on a provider-confirmed
 * overflow while the turn is still open, and it can answer `{kind:'retry'}` —
 * so one overflow compaction can shrink the surface and the attempt re-runs
 * instead of the turn dying.
 *
 * @param ctx - the fiber that already holds the compaction dependency.
 * @param maxRetriesPerTurn - overflow recoveries allowed per turn.
 * @param ownership - the per-activation latch shared with the compaction guard.
 */
function registerOverflowRecovery(ctx, maxRetriesPerTurn, ownership) {
  /**
   * Overflow compactions already spent, keyed by session. `assistant/message`
   * is the one durable signal that the request finally succeeded, and it is the
   * same reset `compaction-basic` uses for its own overflow budget; `agent/status`
   * and `agent/turn-stopping` are emitted without an agent reference, so they
   * cannot key this.
   */
  const spent = new WeakMap()

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'assistant/message' && spent.has(session)) spent.delete(session)
  })

  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (signal?.aborted) return next()
    if (!isOverflowFailure(failure)) return next()

    const session = agent?.session
    if (session === undefined) return next()
    const used = spent.get(session) ?? 0
    if (used >= maxRetriesPerTurn) {
      ctx.logger?.warn?.(
        `infinite-context: context overflow persisted after ${used} recoveries; ending the turn`,
      )
      return next()
    }

    // Another layer owns compression here, so DSH cannot shrink the surface: a
    // native compaction call is refused outright. That layer also shrinks the
    // oversized request itself once it sees the overflow, so re-sending is the
    // recovery — and it costs one round-trip instead of a guaranteed 403.
    if (ownership.value === true) {
      spent.set(session, used + 1)
      ctx.logger?.info?.(
        'infinite-context: context overflow; re-sending so the owner of compression can shrink the request',
      )
      return { kind: 'retry' }
    }

    const compaction = ctx.get('compaction')
    if (compaction === null || typeof compaction !== 'object') return next()
    if (typeof compaction.compactIfNeeded !== 'function') return next()

    const before = session.surface?.replaceGeneration
    spent.set(session, used + 1)
    try {
      const result = await compaction.compactIfNeeded(agent, 'context-overflow', signal)
      if (signal?.aborted) return next()
      if (result === null || result === undefined) return next()
      ctx.logger?.info?.(
        `infinite-context: recovered from context overflow; shadowed ${result.shadowedSeqs?.length ?? 0} nodes, retrying the request`,
      )
      return { kind: 'retry' }
    } catch (error) {
      // Ownership can still be learned here when the activation-time probe could
      // not decide (no presence marker, unreadable config). Latch it, explain
      // once, and retry so the new owner gets its chance to shrink.
      if (isCompactionRefusal(error)) {
        latchProxyOwnership(ownership)
        return { kind: 'retry' }
      }
      // A compaction that failed *after* durably shrinking the surface still
      // made progress, so retrying is correct and cannot loop forever: the
      // attempt budget above is already charged.
      const progressed = before !== undefined && session.surface?.replaceGeneration > before
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`infinite-context: overflow recovery failed: ${message}`)
      return progressed ? { kind: 'retry' } : next()
    }
  })
}

/**
 * Normalize one delegation band setting: a number in (0, 1), else the default.
 */
function ratioIn(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1
    ? value
    : fallback
}

/**
 * Read the delegation config once, with every default applied.
 *
 * Bands are the fraction of the window still REMAINING, which is how the user
 * phrases the feature and how the model reads its own meter: `warn: 0.1` means
 * "start delegating when 10% of the window is left", and `critical: 0.05` is
 * the point where the plugin stops trusting persuasion.
 *
 * `autoSpawn` gates the plugin's own rescue subagents at the critical band.
 * Default false: the model-driven protocol (the advisory) is the primary
 * mechanism, and spontaneous child sessions are an explicit operator choice
 * because they consume real quota.
 */
function compileDelegation(raw) {
  const c = raw !== null && typeof raw === 'object' ? raw : {}
  const warn = ratioIn(c.warnRemaining, DEFAULT_DELEGATE_WARN)
  const critical = Math.min(ratioIn(c.criticalRemaining, DEFAULT_DELEGATE_CRITICAL), warn)
  return {
    enabled: c.enabled !== false,
    warn,
    critical,
    autoSpawn: c.autoSpawn === true,
    maxActive: isPositiveInt(c.maxActive) ? c.maxActive : DEFAULT_DELEGATE_MAX_ACTIVE,
  }
}

/**
 * Delegation advice injected into every system prompt.
 *
 * This is mechanism 4, and it is the part that makes the model delegate on its
 * own: the protocol below is what the main thread is told to do when its window
 * runs low, so the decision happens in the model rather than in a heuristic.
 * The text is deliberately short — it rides on every request — and it names the
 * exact band boundaries so the model can act without being reminded mid-turn.
 */
const DELEGATION_PROTOCOL = [
  'Context-budget protocol (enforced by the infinite-context plugin):',
  '- Your context window is finite. Watch how much of it your own work has consumed.',
  '- At ~10% remaining (warn band): stop absorbing new material into this thread. Push each remaining unit of work into a subagent with a self-contained prompt — file paths, exact requirements, and the definition of done — and keep only the child\'s final result here.',
  '- At ~5% remaining (critical band): delegate FIRST, before anything else. Do not start a new line of work inline. If several pieces are independent, spawn them as parallel subagents rather than one at a time.',
  '- Prefer one subagent per independent task over one giant subagent: children do not share this thread\'s budget.',
  '- Never dump a subagent\'s full transcript back into this thread; ask for a result summary and file paths instead.',
].join('\n')

/**
 * Install mechanism 5: pressure-adaptive delegation.
 *
 * Two halves, deliberately split by who acts:
 *
 *  - ADVISE (always on when `systemPrompt` is reachable): a persistent section
 *    teaches the delegation protocol, so the model can act on its own judgment
 *    the way the user asked for. Registered through the official
 *    `ctx.systemPrompt.section` registry so disposal is automatic.
 *
 *  - MEASURE + ACT: an `agent/pre-step` listener measures the live session
 *    surface with the top-level `tokenMeter` service against the RULE's
 *    truthful window and latches per-session bands, logging each crossing.
 *    When a session first enters the CRITICAL band the plugin spawns up to
 *    `maxActive` fresh-context subagents through `ctx.subagents.start('spawn',
 *    ...)` — the same seam the built-in subagent tool uses — carrying a
 *    self-contained work order, so the heavy reading/writing leaves the main
 *    thread's budget even if the model never acts on the advisory. This
 *    auto-spawn is an explicit operator choice (`delegation.autoSpawn: true`,
 *    default false) because children consume real quota; the band latch caps
 *    it at one spawn round per session.
 *
 * @returns nothing; all registrations are on `ctx` and disposed with it.
 */
function installDelegation(ctx, cfg, rules, proxyOwnsLane) {
  /**
   * The number that matters is the REAL window, never the widened one: on a
   * proxy-owned lane the raw surface is unbounded by design, so percentage
   * against `proxyOwnedContextWindow` would never leave the ok band. The rule's
   * truthful window is what "5% left" means to a person.
   *
   * The provider/model route is read from `agent.requestConfig` when present;
   * anything missing simply yields no reading, so an agent shape this plugin
   * does not recognize degrades to silence instead of to a wrong percentage.
   */
  function measurePressure(meter, agent) {
    if (meter === null || typeof meter !== 'object') return undefined
    if (typeof meter.measure !== 'function') return undefined
    const session = agent?.session
    if (session === undefined) return undefined
    let measurement
    try {
      measurement = meter.measure(session)
    } catch {
      return undefined
    }
    if (measurement === null || typeof measurement !== 'object') return undefined
    if (typeof measurement.totalTokens !== 'number') return undefined

    const rule = ruleFor(rules, agent?.requestConfig?.provider ?? '', agent?.requestConfig?.model ?? '')
    const window = rule !== undefined ? rule.contextWindow : undefined
    if (!isPositiveInt(window)) return undefined
    return {
      totalTokens: measurement.totalTokens,
      window,
      remaining: Math.max(0, 1 - measurement.totalTokens / window),
    }
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal?.aborted) return next()
    try {
      const meter = ctx.get('tokenMeter', false)
      const pressure = measurePressure(meter, agent)
      if (pressure !== undefined) {
        const nextBand = bandFor(pressure, cfg)
        const session = agent.session
        const previous = bandStateMap.get(session)
        if (previous !== nextBand) {
          if (nextBand !== 'ok') {
            log?.warn?.(bandMessage(agent, pressure, nextBand))
          } else if (previous !== undefined) {
            log?.info?.(bandMessage(agent, pressure, nextBand))
          }
          // ACT: first entry into the critical band. `autoSpawn` is an
          // explicit operator choice and is honored on every lane, proxy-owned
          // or not; the band latch below caps it at one spawn per session.
          // Fire-and-forget: the child must never block or fail the step.
          if (nextBand === 'critical' && cfg.autoSpawn) {
            spawnDelegates(ctx, agent, pressure, cfg, proxyOwnsLane)
          }
        }
        bandStateMap.set(session, nextBand)
      }
    } catch (error) {
      // Telemetry must never break the step.
      trace(`delegation telemetry failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  // Persistent advice. `systemPrompt` is a top-level service, so this reaches
  // every agent in the profile; registration is effect-scoped for cleanup.
  const sp = ctx.get('systemPrompt', false)
  if (sp !== undefined && typeof sp.section === 'function' && typeof sp.getSectionOrder === 'function') {
    try {
      const section = sp.section({
        name: 'infinite-context:delegation',
        order: sp.getSectionOrder('TOOL_SUBAGENT'),
        text: () => delegationAdvisory(cfg),
      })
      ctx.effect(
        () => () => {
          if (typeof sp.removeSection === 'function') {
            try { sp.removeSection('infinite-context:delegation') } catch {}
          }
        },
        'infinite-context: delegation advisory section',
      )
      trace('delegation advisory section registered')
      return section === undefined ? undefined : () => {}
    } catch (error) {
      ctx.logger?.warn?.(
        `infinite-context: could not register the delegation advisory: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else {
    ctx.logger?.warn?.(
      'infinite-context: systemPrompt service unavailable; delegation advice is not injected, telemetry still runs',
    )
  }
  return () => {}
}

/** Classify one pressure reading into a band. */
function bandFor(pressure, cfg) {
  if (pressure.remaining <= cfg.critical) return 'critical'
  if (pressure.remaining <= cfg.warn) return 'warn'
  return 'ok'
}

/**
 * Spawn the critical-band workers.
 *
 * The work order is deliberately generic: this plugin cannot know what the
 * turn was asked to do, so the child is told the situation — the main thread
 * is out of context budget — and pointed at the two artifacts it can trust,
 * the workspace and its own tools. What makes this useful despite the
 * generality is that the child runs with a FRESH context window: the exact
 * scenario where the main thread has no room left is the scenario where a
 * child has all of it.
 *
 * Any failure here is logged and swallowed: delegation is an optimization, and
 * a spawn seam that moved between Harness versions must never take the turn
 * down with it.
 */
function spawnDelegates(ctx, agent, pressure, cfg, proxyOwnsLane) {
  const subagents = ctx.get('subagents', false)
  if (subagents === undefined || typeof subagents.start !== 'function') {
    trace('critical band reached but ctx.subagents.start is unavailable; skipping auto-spawn')
    return
  }
  const route = `${agent?.requestConfig?.provider ?? '?'}/${agent?.requestConfig?.model ?? '?'}`
  const laneNote = proxyOwnsLane
    ? `\n\nNote: this session runs behind a reversible-compression proxy, so the parent's raw token count ` +
      `overstates how much of the model window is truly busy — your job is still valid: give the parent's ` +
      `thread room by taking the remaining work into your own fresh window.`
    : ''
  const prompt =
    `You are a fresh-context worker spawned by the infinite-context plugin. ` +
    `The parent session that created you has exhausted its context window ` +
    `(${pressure.totalTokens} of ${pressure.window} tokens used; only ` +
    `${(pressure.remaining * 100).toFixed(1)}% remains), so you are taking over its ` +
    `remaining work with a full, empty window of your own.${laneNote}\n\n` +
    `What to do:\n` +
    `1. Read the parent's working directory and any AGENTS.md / CLAUDE.md for ground truth — do not assume.\n` +
    `2. Identify the most recent unfinished task from the files you find and COMPLETE it, end to end.\n` +
    `3. Write your results to files, not just to your reply, so the parent can pick them up without pasting your transcript.\n\n` +
    `Rules: work autonomously; do not ask the parent questions (it cannot afford the tokens to answer); ` +
    `prefer verifying your work over describing it; keep your final reply to a short summary plus the paths of everything you wrote.`

  for (let i = 0; i < cfg.maxActive; i += 1) {
    const label = `infinite-context-rescue-${i + 1}`
    subagents
      .start('spawn', {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
      })
      .then((run) => {
        if (run?.result !== undefined && typeof run.result?.then === 'function') {
          return run.result
        }
        return run
      })
      .then((result) => {
        log?.info?.(
          `infinite-context: rescue subagent "${label}" finished (${result?.stopReason ?? 'unknown'})`,
        )
      })
      .catch((error) => {
        log?.warn?.(
          `infinite-context: rescue subagent "${label}" failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }
  log?.warn?.(
    `infinite-context: critical context pressure on ${route} — spawned ${cfg.maxActive} rescue subagent(s) with fresh windows`,
  )
}

/** Per-session band latch, so each crossing is reported exactly once. */
const bandStateMap = new WeakMap()

/**
 * One log line per crossing, naming the band, the numbers behind it, and what
 * the plugin did about it — so the log explains itself instead of merely
 * asserting that something happened.
 */
function bandMessage(agent, pressure, band) {
  const pct = (pressure.remaining * 100).toFixed(1)
  const route = `${agent?.requestConfig?.provider ?? '?'}/${agent?.requestConfig?.model ?? '?'}`
  if (band === 'critical') {
    return (
      `infinite-context: CRITICAL context pressure — ${pct}% of the window remains ` +
      `(${pressure.totalTokens} of ${pressure.window} tokens) on ${route}. ` +
      `Delegate the remaining work to subagents now; this thread should only collect results.`
    )
  }
  return (
    `infinite-context: context entering the warn band — ${pct}% remaining ` +
    `(${pressure.totalTokens} of ${pressure.window} tokens) on ${route}. ` +
    `Begin delegating independent work to subagents.`
  )
}

/**
 * The static protocol text. Independent of live numbers so it stays byte-stable
 * across requests: a section whose text changes every step would defeat prompt
 * caching on every request, which is the one thing this plugin exists to avoid.
 */
function delegationAdvisory(cfg) {
  return (
    `Context budget bands (fraction of the window still free): ` +
    `warn at <= ${Math.round(cfg.warn * 100)}%, critical at <= ${Math.round(cfg.critical * 100)}%. ` +
    DELEGATION_PROTOCOL
  )
}

export default apply
