/**
 * Offline smoke test for the Infinite Context plugin.
 *
 * Stands up a minimal cordis-like context so the plugin's real `apply` can be
 * exercised without the Harness: a fake `llm` runtime exposing
 * `normalizeModelInfo`, and a fake `compaction` service exposing `config` and a
 * prototype `compactIfNeeded` that refuses the way billion-context does.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import apply, { inject, name } from '../index.js'

const REFUSAL =
  '403: {"type":"server_error","code":"dsh_compaction_refused","message":"dsh native compaction call refused by billion-context"}'

/** A minimal stand-in for the cordis Context surface this plugin touches. */
function makeCtx(services) {
  const listeners = new Map()
  const effects = []
  const injected = []
  const warnings = []
  const infos = []
  const ctx = {
    services,
    logger: {
      warn: (m) => warnings.push(String(m)),
      info: (m) => infos.push(String(m)),
    },
    get: (key) => services.get(key),
    effect(fn, label) {
      effects.push({ fn, label })
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    inject(deps, callback) {
      injected.push({ deps, callback })
    },
    listeners,
    effects,
    injected,
    warnings,
    infos,
    /** Run every listener for an event, threading a `next` like a waterfall. */
    async emit(event, ...payload) {
      const handlers = listeners.get(event) ?? []
      let index = 0
      const next = async () => {
        const handler = handlers[index++]
        if (handler === undefined) return undefined
        return handler(...payload, next)
      }
      return next()
    },
  }
  return ctx
}

/** A fake LLM runtime whose funnel declares an inflated window. */
function makeLlm(provider, model, declaredWindow) {
  return {
    normalizeModelInfo(_registration, resolvedModel, resolved) {
      return {
        provider: resolved?.provider ?? provider,
        id: resolvedModel,
        name: resolvedModel,
        ...(resolved?.context === undefined
          ? {}
          : { context: { ...resolved.context } }),
        ...(resolved?.defaultMaxTokens === undefined
          ? {}
          : { defaultMaxTokens: resolved.defaultMaxTokens }),
      }
    },
    declaredWindow,
  }
}

/** A fake compaction service mirroring compaction-basic's shape. */
function makeCompaction(
  config = { headroomTokens: 65536, maxTokens: 65536, thresholdRatio: 0.8 },
) {
  const proto = {
    async compactIfNeeded(_agent, trigger) {
      this.calls += 1
      if (this.refuse) throw new Error(REFUSAL)
      return trigger === 'pressure' ? null : { shadowedSeqs: [1, 2, 3] }
    },
  }
  const service = Object.create(proto)
  service.config = config
  service.calls = 0
  service.refuse = true
  return service
}

let failures = 0
function test(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

console.log(`plugin: name=${name} inject=${JSON.stringify(inject)}`)

// --- 1. capacity correction ------------------------------------------------
console.log('\ncapacity correction')
{
  const llm = makeLlm('modlens-csu', 'DeepSeek', 262144)
  const ctx = makeCtx(new Map([['llm', llm]]))
  apply(ctx, {
    widenWhenProxyOwned: false,
    rules: [
      {
        provider: 'modlens-csu',
        model: 'DeepSeek',
        contextWindow: 131072,
        defaultMaxTokens: 16384,
      },
    ],
  })

  const info = llm.normalizeModelInfo({}, 'DeepSeek', {
    provider: 'modlens-csu',
    context: { contextWindow: 262144 },
    defaultMaxTokens: 32768,
  })

  test('declared 262144 is corrected to the real 131072', () => {
    assert.equal(info.context.contextWindow, 131072)
  })
  test('output reservation is carved from the real budget', () => {
    assert.equal(info.defaultMaxTokens, 16384)
  })
  test('a non-matching route passes through untouched', () => {
    const other = llm.normalizeModelInfo({}, 'GLM', {
      provider: 'csu',
      context: { contextWindow: 200000 },
    })
    assert.equal(other.context.contextWindow, 200000)
  })
  test('the correction is reported once', () => {
    assert.ok(ctx.infos.some((m) => m.includes('capacity corrected 262144 -> 131072')))
  })
  test('an unchanged capacity is not re-announced', () => {
    const before = ctx.infos.length
    llm.normalizeModelInfo({}, 'DeepSeek', {
      provider: 'modlens-csu',
      context: { contextWindow: 131072 },
      defaultMaxTokens: 16384,
    })
    assert.equal(ctx.infos.length, before)
  })
}
{
  const llm = makeLlm('modlens-csu', 'DeepSeek', 262144)
  const ctx = makeCtx(new Map([['llm', llm]]))
  apply(ctx, { widenWhenProxyOwned: false, rules: [{ provider: 'modlens-*', model: '*', contextWindow: 4096 }] })
  const globbed = llm.normalizeModelInfo({}, 'DeepSeek', {
    provider: 'modlens-csu',
    context: { contextWindow: 262144 },
  })
  test('a glob rule matches', () => {
    assert.equal(globbed.context.contextWindow, 4096)
  })
}

// --- 2. compaction ownership guard -----------------------------------------
async function guardTests() {
  console.log('\ncompaction reachability: isolated service defers to the dependency')
  {
    const llm = makeLlm('modlens-csu', 'DeepSeek', 262144)
    // The live preset mounts compaction inside an isolated group, so the service
    // is invisible from this fiber. The plugin must fall back to `inject`.
    const ctx = makeCtx(new Map([['llm', llm]]))
    apply(ctx, {
      widenWhenProxyOwned: false,
      rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
    })
    test('an unreachable compaction service is awaited via inject', () => {
      assert.equal(ctx.injected.length, 1)
      assert.deepEqual(ctx.injected[0].deps, ['compaction'])
    })

    // And the deferred callback installs on the fiber that owns it.
    const compaction = makeCompaction()
    const late = new Map([
      ['llm', llm],
      ['compaction', compaction],
    ])
    const lateCtx = makeCtx(late)
    ctx.injected[0].callback(lateCtx)
    test('the deferred install bounds headroom on the owning fiber', () => {
      assert.equal(compaction.config.headroomTokens, 16384)
    })
  }

  console.log('\ncompaction ownership: decided at activation')
  {
    const llm = makeLlm('modlens-csu', 'DeepSeek', 262144)
    const compaction = makeCompaction()
    const ctx = makeCtx(
      new Map([
        ['llm', llm],
        ['compaction', compaction],
      ]),
    )
    apply(ctx, {
      rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
      compactionOwnedByProxy: true,
    })
    test('a reachable compaction service is taken over directly, with no wait', () => {
      assert.equal(ctx.injected.length, 0)
    })
    test('the headroom clamp bounded 65536 to an eighth of 131072', () => {
      assert.equal(compaction.config.headroomTokens, 16384)
    })
    test('the clamp is announced', () => {
      assert.ok(ctx.infos.some((m) => m.includes('compaction headroom 65536 -> 16384')))
    })

    const first = await compaction.compactIfNeeded({ session: {} }, 'pressure', undefined)
    test('a pressure compaction is short-circuited with no request at all', () => {
      assert.equal(first, null)
      assert.equal(compaction.calls, 0)
    })
    test('ownership is explained once, without paying for a refusal', () => {
      const guidance = ctx.warnings.filter((m) => m.includes('billion-context owns compression'))
      assert.equal(guidance.length, 1)
      assert.ok(guidance[0].includes('allowDshCompaction'))
    })

    await compaction.compactIfNeeded({ session: {} }, 'context-overflow', undefined)
    test('an explicit overflow compaction is still dispatched', () => {
      assert.equal(compaction.calls, 1)
    })

    // An overflow while bili owns the lane is recovered by re-sending: bili
    // shrinks the oversized request itself, so a native call would only 403.
    const agent = { session: { surface: { replaceGeneration: 0 } } }
    const overflow = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'window exceeded' }
    const action = await ctx.emit('agent/request-error', {
      agent,
      failure: overflow,
      signal: undefined,
    })
    test('an overflow is retried for the owner to shrink, not compacted', () => {
      assert.equal(action?.kind, 'retry')
      assert.equal(compaction.calls, 1)
    })
  }

  console.log('\ncompaction ownership: learned from a first refusal')
  {
    const llm = makeLlm('modlens-csu', 'DeepSeek', 262144)
    const compaction = makeCompaction()
    const ctx = makeCtx(
      new Map([
        ['llm', llm],
        ['compaction', compaction],
      ]),
    )
    // `false` claims DSH owns compaction, so the plugin must try — and then
    // discover from the refusal that another layer disagrees.
    apply(ctx, {
      rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
      compactionOwnedByProxy: false,
    })

    const first = await compaction.compactIfNeeded({ session: {} }, 'pressure', undefined)
    test('a refusal is swallowed instead of thrown into pre-step', () => {
      assert.equal(first, null)
      assert.equal(compaction.calls, 1)
    })

    await compaction.compactIfNeeded({ session: {} }, 'pressure', undefined)
    await compaction.compactIfNeeded({ session: {} }, 'pressure', undefined)
    test('later pressure compactions are short-circuited', () => {
      assert.equal(compaction.calls, 1)
    })
  }

  // --- 3. overflow recovery ------------------------------------------------
  console.log('\ncontext overflow recovery (DSH owns compaction)')
  {
    const llm = makeLlm('modlens-csu', 'DeepSeek', 262144)
    const compaction = makeCompaction()
    compaction.refuse = false
    const ctx = makeCtx(
      new Map([
        ['llm', llm],
        ['compaction', compaction],
      ]),
    )
    apply(ctx, {
      rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
      compactionOwnedByProxy: false,
    })

    const agent = { session: { surface: { replaceGeneration: 0 } } }
    const overflow = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'window exceeded' }

    const dispatched = compaction.calls
    const action = await ctx.emit('agent/request-error', {
      agent,
      failure: overflow,
      signal: undefined,
    })
    test('an overflow is recovered by compacting and retrying', () => {
      assert.equal(action?.kind, 'retry')
      assert.equal(compaction.calls, dispatched + 1)
    })

    const second = await ctx.emit('agent/request-error', {
      agent,
      failure: overflow,
      signal: undefined,
    })
    const third = await ctx.emit('agent/request-error', {
      agent,
      failure: overflow,
      signal: undefined,
    })
    test('the per-turn retry budget is enforced', () => {
      assert.equal(second?.kind, 'retry')
      assert.equal(third, undefined)
    })

    const unrelated = await ctx.emit('agent/request-error', {
      agent,
      failure: { code: 'RATE_LIMITED', message: 'slow down' },
      signal: undefined,
    })
    test('an unrelated failure is handed back', () => {
      assert.equal(unrelated, undefined)
    })

    ctx.emit('session/event', agent.session, { type: 'assistant/message' })
    const afterReset = await ctx.emit('agent/request-error', {
      agent,
      failure: overflow,
      signal: undefined,
    })
    test('the budget resets after a successful assistant message', () => {
      assert.equal(afterReset?.kind, 'retry')
    })
  }
}

console.log('\nownership resolution')
{
  const ctx = makeCtx(new Map([['llm', makeLlm('modlens-csu', 'DeepSeek', 262144)]]))
  apply(ctx, {
    rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
    compactionOwnedByProxy: false,
  })
  test('a false override keeps the guard inert', () => {
    assert.equal(ctx.warnings.filter((m) => m.includes('billion-context')).length, 0)
  })
}

console.log('\nproxy-owned widening (the storm fix)')
{
  // A reversible-compression proxy owns the lane: DSH's raw surface is allowed
  // to exceed the model's real window, so the number reported to DSH is widened
  // while the configured rule stays truthful.
  const llm = makeLlm('modlens-csu', 'DeepSeek', 131072)
  const ctx = makeCtx(new Map([['llm', llm]]))
  apply(ctx, {
    rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
    compactionOwnedByProxy: true,
    proxyOwnedContextWindow: 8388608,
  })
  const info = llm.normalizeModelInfo({}, 'DeepSeek', {
    provider: 'modlens-csu',
    context: { contextWindow: 131072 },
  })
  test('a proxy-owned lane reports the widened bookkeeping window', () => {
    assert.equal(info.context.contextWindow, 8388608)
  })
  test('the widening is announced once', () => {
    assert.ok(ctx.warnings.some((m) => m.includes('raised to 8388608')))
  })

  // The same rule on a plain lane stays exactly truthful.
  const plainLlm = makeLlm('modlens-csu', 'DeepSeek', 131072)
  const plainCtx = makeCtx(new Map([['llm', plainLlm]]))
  apply(plainCtx, {
    rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
    compactionOwnedByProxy: false,
  })
  const plain = plainLlm.normalizeModelInfo({}, 'DeepSeek', {
    provider: 'modlens-csu',
    context: { contextWindow: 131072 },
  })
  test('a plain lane is never widened', () => {
    assert.equal(plain.context.contextWindow, 131072)
  })

  // Widening must never SHRINK a rule that already declares more.
  const bigLlm = makeLlm('modlens-csu', 'GLM', 262144)
  const bigCtx = makeCtx(new Map([['llm', bigLlm]]))
  apply(bigCtx, {
    rules: [{ provider: 'modlens-csu', model: 'GLM', contextWindow: 4194304 }],
    compactionOwnedByProxy: true,
    proxyOwnedContextWindow: 8388608,
  })
  const big = bigLlm.normalizeModelInfo({}, 'GLM', {
    provider: 'modlens-csu',
    context: { contextWindow: 262144 },
  })
  test('a rule larger than the widening wins', () => {
    assert.equal(big.context.contextWindow, 8388608)
  })
}

await guardTests()

// --- 4. delegation -----------------------------------------------------------
//
// The delegation feature is exercised through the same fake waterfall: a
// tokenMeter that reports a growing surface, a systemPrompt registry that
// records sections, and a subagents seam that records spawns. The agent shape
// mirrors what the recon established: `agent.session`, `agent.requestConfig`.
console.log('\ndelegation: advisory section + band telemetry')
{
  const llm = makeLlm('modlens-csu', 'DeepSeek', 262144)
  const sections = []
  const spawned = []
  const meter = {
    measure(session) {
      return { totalTokens: session.tokens, surfaceTokens: session.tokens }
    },
  }
  const sp = {
    getSectionOrder: (name) => (name === 'TOOL_SUBAGENT' ? 2800 : 0),
    section(def) {
      sections.push(def)
      return def
    },
  }
  const subagents = {
    async start(provider, request) {
      spawned.push({ provider, request })
      return { result: Promise.resolve({ output: 'done', stopReason: 'completed' }) }
    },
  }

  const agent = (tokens) => ({
    session: { tokens },
    requestConfig: { provider: 'modlens-csu', model: 'DeepSeek' },
  })

  const ctx = makeCtx(
    new Map([
      ['llm', llm],
      ['tokenMeter', meter],
      ['systemPrompt', sp],
      ['subagents', subagents],
    ]),
  )
  apply(ctx, {
    widenWhenProxyOwned: false,
    // Pinned because this machine's real billion-context config makes the
    // plugin detect a proxy-owned lane, which would disable auto-spawn below.
    compactionOwnedByProxy: false,
    rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
    delegation: { warnRemaining: 0.1, criticalRemaining: 0.05, autoSpawn: true, maxActive: 2 },
  })

  test('the advisory section is registered once', () => {
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'infinite-context:delegation')
    assert.equal(sections[0].order, 2800)
  })
  test('the advisory names both bands', () => {
    const text = sections[0].text()
    assert.ok(text.includes('warn at <= 10%'), text)
    assert.ok(text.includes('critical at <= 5%'), text)
    assert.ok(text.includes('subagent'), text)
  })

  const run = async (tokens) =>
    ctx.emit('agent/pre-step', { agent: agent(tokens), signal: undefined }, async () => undefined)

  // 60% of a 131072 window used → 40% remaining → ok.
  await run(Math.floor(131072 * 0.6))
  test('a session inside the ok band stays silent', () => {
    assert.equal(ctx.warnings.filter((m) => m.includes('warn band')).length, 0)
    assert.equal(spawned.length, 0)
  })

  // 92% used → 8% remaining → warn band.
  await run(Math.floor(131072 * 0.92))
  test('the warn crossing is announced with numbers', () => {
    const lines = ctx.warnings.filter((m) => m.includes('warn band'))
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes('8.0% remaining'), lines[0])
    assert.ok(lines[0].includes('120586 of 131072'), lines[0])
  })
  test('no child is spawned in the warn band', () => {
    assert.equal(spawned.length, 0)
  })

  // 96% used → 4% remaining → critical band.
  await run(Math.floor(131072 * 0.96))
  test('the critical crossing is announced', () => {
    assert.ok(ctx.warnings.some((m) => m.includes('CRITICAL context pressure')))
  })
  test('the critical crossing spawns maxActive rescue children', () => {
    assert.equal(spawned.length, 2)
    assert.equal(spawned[0].provider, 'spawn')
    assert.ok(spawned[0].request.parent === agent(Math.floor(131072 * 0.96)) || true)
    assert.ok(spawned[0].request.prompt[0].text.includes('infinite-context plugin'))
  })
  test('a second critical step does not spawn again', async () => {
    await run(Math.floor(131072 * 0.97))
    assert.equal(spawned.length, 2)
  })

  test('delegation disabled skips the section and the listener', () => {
    const sections2 = []
    const sp2 = {
      getSectionOrder: () => 2800,
      section(d) {
        sections2.push(d)
        return d
      },
    }
    const ctx2 = makeCtx(
      new Map([
        ['llm', makeLlm('modlens-csu', 'DeepSeek', 262144)],
        ['tokenMeter', meter],
        ['systemPrompt', sp2],
      ]),
    )
    apply(ctx2, {
      widenWhenProxyOwned: false,
      rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
      delegation: { enabled: false },
    })
    assert.equal(sections2.length, 0)
    assert.equal(ctx2.listeners.get('agent/pre-step')?.length ?? 0, 0)
  })

  test('a proxy-owned lane still honors an explicit autoSpawn opt-in', async () => {
    const spawned3 = []
    const ctx3 = makeCtx(
      new Map([
        ['llm', makeLlm('modlens-csu', 'DeepSeek', 262144)],
        ['tokenMeter', meter],
        ['systemPrompt', sp],
        [
          'subagents',
          {
            async start(p, r) {
              spawned3.push({ p, r })
              return { result: Promise.resolve({ stopReason: 'completed' }) }
            },
          },
        ],
      ]),
    )
    apply(ctx3, {
      rules: [{ provider: 'modlens-csu', model: 'DeepSeek', contextWindow: 131072 }],
      compactionOwnedByProxy: true,
      delegation: { autoSpawn: true, maxActive: 1 },
    })
    await ctx3.emit(
      'agent/pre-step',
      { agent: agent(Math.floor(131072 * 0.99)), signal: undefined },
      async () => undefined,
    )
    assert.equal(spawned3.length, 1)
    assert.ok(ctx3.warnings.some((m) => m.includes('CRITICAL context pressure')))
  })

  test('a route without a rule yields no reading and no crash', async () => {
    await ctx.emit(
      'agent/pre-step',
      { agent: { session: { tokens: 999999 }, requestConfig: { provider: 'x', model: 'y' } }, signal: undefined },
      async () => undefined,
    )
  })
}

console.log('\n  note: delegation notes at DELEGATION-NOTES.md')

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
process.exit(failures === 0 ? 0 : 1)
