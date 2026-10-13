# Delegation feature — API contract notes (v1.2)

Verified by reading the shipped plugin bundles inside a DSH desktop
installation (`resources/app.asar.unpacked/node_modules/@deepseek-ai/<pkg>/lib/index.js`)
— recon against the installed app, not the live runtime. Line numbers refer to
those bundles; they are stable for a given DSH release and may shift on
upgrade, so re-verify after upgrading DSH.

## Seams this feature uses

| need | service | proof |
| --- | --- | --- |
| spawn a child | `ctx.subagents.start(name, request)` | `dsh-subagent.js:2834` `super(ctx, "subagents")` |
| live token pressure | `ctx.get('tokenMeter').measure(session)` | `dsh-token-meter.js:641` |
| text the model always sees | `ctx.systemPrompt.section({name, order, text})` | `dsh-system-prompt.js:240-243` |
| per-step rewrite | `agent/pre-step` waterfall | `dsh-agent-loop.js:911-918` |

## 1. Subagent spawn

```js
const run = await ctx.subagents.start('spawn', {
  label,                                  // short display label
  prompt: [{ type: 'text', text }],       // content parts
  parent: agent,                          // the Agent object from the event payload
  signal,                                 // cancellation
})
const result = await run.result            // { output, structured?, stopReason }
// stopReason: completed | aborted | error | max-tokens | refusal
```

- Service: `ctx.subagents` (`dsh-subagent.js:2834`). Config: `maxDepth` 1,
  `maxActiveSubagents` 8. Top-level — injectable from any host plugin.
- Foreground tool usage: `dsh-tool-subagent.js:557`
  `settleForegroundRun(await runtimeCtx.subagents.start(config.provider, {...request, signal}))`.
- Background/continuable: `startContinuable({provider,label,request,signal})` → `.childId`.
- Raw primitive (`dsh-subagent-in-process-driver.js`):
  `await parent.ctx.agents.create({sessionId, parentAgent, meta, seed?, agentOptions, signal, setup})`
  then `child.followup(createUserMessage({content}))`, `await child.whenIdle()`.
- Providers: `dsh-subagent-spawn-in-process` (fresh child),
  `dsh-subagent-fork-in-process` (`inheritsParentContext = true`).
- Control tools: `dsh-tool-subagent-control.js` injects `["tools","subagents"]`.
- Ralph: `inject=["tools","workflowEngine","subagents","systemPrompt"]`,
  `ctx.subagents.getProvider(name)`; workflowEngine = `dsh-workflow-ptc.js:580-584`
  `static inject = ["subagents","ptcRuntime","sandboxPolicy"]`.
- No package named `delegation` exists anywhere (checked all 289 names).

## 2. Token pressure

```js
const meter = ctx.get('tokenMeter')      // top-level, key "tokenMeter"
const m = meter.measure(agent.session)   // requestHeader optional
// m = { logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }
// baseline = { kind: "usage"|"estimated"|"none", tokens, usage? }
// usage buckets: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
```

`CHARS_PER_TOKEN = 4` heuristic when no usage. compaction-basic consumes it at
`dsh-compaction-basic.js:918-919`. Top-level service, NOT preset-isolated.

## 3. Event payload

`agent` is fused into every `agent/*` payload by `dsh-agent.js:242-246`
`const fused = (payload) => ({ ...payload, agent })` — a top-level listener
receives it. Stable id: `agent.session.id` (=== `agent.id`, `dsh-agent.js:512`).

## 4. Injecting text the model sees

```js
// persistent section — official registry API
ctx.effect(() => ctx.systemPrompt.section({
  name: 'infinite-context:delegation',
  order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),  // 2800
  text: (context) => renderAdvice(),                          // may be a function -> dynamic
}), 'infinite-context: delegation section')

// message rewrite (proven by dsh-time-context.js:215-246)
ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
  const decision = await next()          // { kind: 'enter', messages }
  return { ...decision, messages: [...decision.messages, myMessage] }
})
```

Section order table: `DEPLOYMENT_PERSONA_PREFIX:0, TOOL_SUBAGENT:2800,
STRUCTURED_OUTPUT:9900, DEPLOYMENT_PERSONA_SUFFIX:10200`.

## 5. What already exists (compose, do not reimplement)

- Subagents: `dsh-subagent`, `dsh-subagent-spawn-in-process`, `dsh-subagent-fork-in-process`,
  `dsh-subagent-in-process-driver`, `dsh-tool-subagent`, `dsh-tool-subagent-control`,
  `dsh-tool-ralph`, `dsh-workflow`(+`ptc`+`tool`), `dsh-experimental-agent-team`.
- Pressure: `dsh-token-meter`, `dsh-compaction-basic`, `dsh-spill-policy`,
  `dsh-compaction-tool-result-pruner`.
- System prompt: `dsh-system-prompt`, `dsh-persona`, `dsh-agent-instructions`,
  `dsh-time-context`, `dsh-tmux-context`.

## Caveats

- All verified from extracted bundles, not the live runtime.
- `subagents` / `agents` / `systemPrompt` / `tokenMeter` are top-level services;
  compaction-basic's preset isolation does NOT generalize to them.
- Section registration is effect-scoped: wrap in `ctx.effect(() => ...)`.
- No package named `delegation` exists anywhere.
