// One-off isolated test for secret redaction (P0 first item).
//  (A) unit tests of the exported `redactSecrets`.
//  (B) memory_remember (entries write) redacts on disk.
//  (C) pipeline: a session whose transcript holds secrets → draft file is redacted.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply, redactSecrets } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// ── (A) redactSecrets unit tests ─────────────────────────────────────────────
console.log('[A] redactSecrets unit tests')
check(redactSecrets('key is sk-1234567890abcdef end') === 'key is [REDACTED] end', 'sk- OpenAI/Anthropic key redacted')
check(redactSecrets('Authorization: Bearer sekrit123!!') === 'Authorization: [REDACTED]', 'Authorization header value redacted')
check(redactSecrets('use Bearer sekrit123 please') === 'use Bearer [REDACTED] please', 'Bearer token redacted')
check(redactSecrets('aws key AKIAIOSFODNN7EXAMPLE here') === 'aws key [REDACTED] here', 'AKIA AWS key redacted')
check(redactSecrets('db PASSWORD=P@ssw0rd! ok') === 'db PASSWORD=[REDACTED] ok', 'PASSWORD= value redacted (label kept)')
check(redactSecrets('header x-api-key: 9876543210abcdef done') === 'header x-api-key: [REDACTED] done', 'x-api-key value redacted')
check(redactSecrets('token = "my.secret.value" here') === 'token = [REDACTED] here', 'quoted token value redacted')
check(redactSecrets('placeholder <password> shown') === 'placeholder [REDACTED] shown', '<password> placeholder redacted')
check(redactSecrets('acct AKIAIOSFODNN7EXAMPLE; Password=Sup3rS3cret!!') === 'acct [REDACTED]; Password=[REDACTED]', 'AKIA + PASSWORD both redacted')
check(
  redactSecrets('api eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c') === 'api [REDACTED]',
  'JWT redacted',
)
check(
  redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAexample\n-----END OPENSSH PRIVATE KEY-----') === '[REDACTED]',
  'private-key block redacted',
)
// long base64-ish token (mixed case + digits, length >= 40, standalone): redacted.
const longb64 = 'x' + 'qKqE5mBqRVs0dYfPTuV1aA3xM9nLcE7gHjZ4wQpS2tUkI6oXz8CvF5dNbR1' + 'y'
check(redactSecrets('tok ' + longb64 + ' end') === 'tok [REDACTED] end', 'long base64 token redacted')
// ordinary text must NOT be touched.
check(redactSecrets('set up the build config and run the tests') === 'set up the build config and run the tests', 'ordinary text unchanged')
// pure lowercase hex hash (60 chars) is left alone (false-positive guard).
const hex = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
check(redactSecrets('commit ' + hex + ' end') === 'commit ' + hex + ' end', 'lowercase hex hash not false-redacted')
// idempotent: redacting an already-redacted string is a no-op.
check(redactSecrets('[REDACTED] sk-abcdef') === '[REDACTED] [REDACTED]', 'idempotent / mixed input')

// ── shared mock host for the plugin ─────────────────────────────────────────
function makeCtx(tools, eventHandlers, queryMock) {
  const table = (() => {
    const m = new Map()
    return {
      put: (k, v) => { m.set(k, v); return Promise.resolve() },
      delete: (k) => Promise.resolve(m.delete(k)),
      keys: () => m.keys(),
      entries: () => m.entries(),
      get size() { return m.size },
      _m: m,
    }
  })()
  const ctx = {
    storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
    get: (k) => {
      if (k === 'sessionQuery') return queryMock
      return undefined
    },
    tools: { register: (tool) => { tools[tool.name] = tool } },
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
    on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
  }
  return { ctx, table }
}

// ── (B) memory_remember redacts on the entries write ────────────────────────
console.log('\n[B] memory_remember redacts before writing the entry')
{
  const tools = {}
  const eventHandlers = {}
  const tmp = path.join(os.tmpdir(), 'dsh-rollout-redact-B-' + Date.now())
  process.env.DSH_HOME = tmp
  fs.mkdirSync(tmp, { recursive: true })
  try {
    const { ctx, table } = makeCtx(tools, eventHandlers, undefined)
    await apply(ctx, {})
    const remember = tools['memory_remember']
    assert.ok(remember && typeof remember.execute === 'function', 'memory_remember tool captured')
    const secret = 'credential sk-abcDEF123456 and Password=P@ssw0rd'
    const res = await remember.execute(
      { content: secret, tags: ['secret', 'project'] },
      { agent: { session: { id: 's1' } } },
    )
    const stored = table._m.get(res.id)
    check(stored.content.indexOf('sk-abcDEF123456') === -1, 'remembered content has no raw secret')
    check(stored.content.includes('[REDACTED]'), 'remembered content contains [REDACTED]')
    check(stored.content === 'credential [REDACTED] and Password=[REDACTED]', 'remembered full content redacted')
    check(stored.tags.join(',') === 'secret,project', 'tags preserved (no secret in tags here)')
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

// ── (C) pipeline: secret in the transcript is redacted in the written draft ──
console.log('\n[C] pipeline draft write redacts secrets (D1 transcript + D3 write)')
{
  const tools = {}
  const eventHandlers = {}
  const tmp = path.join(os.tmpdir(), 'dsh-rollout-redact-C-' + Date.now())
  process.env.DSH_HOME = tmp
  fs.mkdirSync(tmp, { recursive: true })
  try {
    const { ctx } = makeCtx(tools, eventHandlers, undefined) // no query plugin → live-object path
    let llmInput = ''
    // Inject a fake LLM that (a) records the transcript it received and (b) returns
    // a summary that itself echoes a secret — so we can verify both D1 and D3.
    ctx.get = (k) => {
      if (k === 'sessionQuery') return undefined
      if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
      if (k === 'llm') {
        return {
          stream: (opts) => {
            const text = opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0]
              ? opts.messages[0].content[0].text
              : ''
            llmInput = text
            return {
              [Symbol.asyncIterator]: async function* () {
                yield { type: 'text-delta', text: JSON.stringify({ rollout_summary: 'summary carries sk-abcDEF123456', raw_memory: 'and Password=P@ssw0rd', slug: 's', keywords: '', title: '' }) }
                yield { type: 'finish', reason: { kind: 'stop' } }
              },
            }
          },
        }
      }
      return undefined
    }
    const config = {
      autoTrigger: 'sessionEnd',
      minIdleHours: 0,
      maxDraftAgeDays: 10,
      maxExtractPerTrigger: 2,
      maxPipelineRunsPerDay: 100,
      precompactAuto: false,
      extractProvider: '',
      extractModel: '',
      extractReasoningEffort: 'low',
    }
    await apply(ctx, config)

    // A LONG secret-bearing transcript so the trigger is a with_output (>= 60 chars).
    const secretSession = {
      id: 'trig',
      header: { cwd: 'C:/trig' },
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: 'the api key is sk-abcDEF123456 and the db Password=P@ssw0rd for our prod deployment on this project' }] },
      ],
    }
    assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
    eventHandlers['session/disposed'](secretSession)
    await new Promise((r) => setTimeout(r, 200))

    // D1: the transcript handed to the LLM must already be redacted.
    check(llmInput.indexOf('sk-abcDEF123456') === -1 && llmInput.indexOf('P@ssw0rd') === -1, 'D1: LLM input has no raw secret')
    check(llmInput.includes('[REDACTED]'), 'D1: LLM input contains [REDACTED]')

    const draftPath = path.join(tmp, 'memories', 'rollout_summaries', 'trig.md')
    check(fs.existsSync(draftPath), 'trigger draft written (with_output)')
    if (fs.existsSync(draftPath)) {
      const txt = fs.readFileSync(draftPath, 'utf8')
      check(txt.indexOf('sk-abcDEF123456') === -1 && txt.indexOf('P@ssw0rd') === -1, 'draft has no raw secret (D3)')
      check(txt.includes('[REDACTED]'), 'draft contains [REDACTED]')
      check(txt.includes('summary carries [REDACTED]'), 'D3: model-echoed secret redacted in draft')
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

console.log(`\n${failed === 0 ? 'ALL REDACT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
