// P0-R2-2 反例：引用匹配禁止「共享一个 ASCII 特征词」即放行。证据「pnpm build failed because
// lockfile was stale」与记忆「user prefers pnpm over npm」共享 pnpm，但前者只证明一次构建失败，
// 不证明用户偏好 pnpm —— 旧实现返回 ok:true（同主题词、不同事实的错误引用），比 unverified 更危险。
// 本轮只接受规范化后的完整子串/明确绑定；三类同关键词反例都必须拒绝，真实子串正例必须仍接受。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { validateSourceRef } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-p0-r2-2-' + Date.now())
fs.mkdirSync(path.join(tmp, 'rollout_summaries'), { recursive: true })
// 一个证据文件，三段不同主题证据（行 1/2/3）。startLine/endLine 对应每段。
const evidenceFile = path.join(tmp, 'rollout_summaries', 'sess.md')
fs.writeFileSync(
  evidenceFile,
  [
    'pnpm build failed because lockfile was stale',
    'the user enabled notifications on the dashboard',
    'the go language is fast for concurrency',
  ].join('\n') + '\n',
  'utf8',
)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const ref = (startLine, endLine) => ({ path: 'rollout_summaries/sess.md', startLine, endLine, citeSpan: '', sessionId: 'sess' })
const validate = (startLine, endLine, content) => {
  const v = validateSourceRef(ref(startLine, endLine), tmp, { content })
  return v
}

// ── 三类「同关键词、不同事实」反例：必须拒绝 Stage1 source_ref ────────────────
console.log('[P0-R2-2] 同关键词但事实关系不同 → 拒绝')
{
  const v = validate(1, 1, 'user prefers pnpm over npm')
  console.log('  validateSourceRef:', JSON.stringify(v))
  check(v.ok === false, 'same-keyword different-fact is REJECTED (evidence: pnpm build failed / memory: user prefers pnpm)')
  check(v.reason === 'unrelated', 'rejection reason = unrelated (not a verified reference)')
}
console.log('[P0-R2-2] 同关键词但否定关系相反 → 拒绝')
{
  const v = validate(2, 2, 'the user disabled notifications on the dashboard')
  console.log('  validateSourceRef:', JSON.stringify(v))
  check(v.ok === false, 'negated-relation is REJECTED (evidence: enabled / memory: disabled)')
  check(v.reason === 'unrelated', 'rejection reason = unrelated')
}
console.log('[P0-R2-2] 同关键词但主体不同 → 拒绝')
{
  const v = validate(3, 3, 'the python language is fast for concurrency')
  console.log('  validateSourceRef:', JSON.stringify(v))
  check(v.ok === false, 'different-subject is REJECTED (evidence: go / memory: python)')
  check(v.reason === 'unrelated', 'rejection reason = unrelated')
}

// ── positive：规范化完整子串仍须通过（不做过头）────────────────────────────────
console.log('[P0-R2-2] 规范化完整子串真实匹配 → 仍接受')
{
  const v = validate(1, 1, 'pnpm build failed')
  console.log('  validateSourceRef:', JSON.stringify(v))
  check(v.ok === true, 'a real full-substring reference is still accepted')
}
console.log('[P0-R2-2] 规范化完整子串跨行段（endLine=0 到文件尾）→ 仍接受')
{
  const v = validate(1, 0, 'the user enabled notifications on the dashboard')
  console.log('  validateSourceRef:', JSON.stringify(v))
  check(v.ok === true, 'a full-substring reference within a later distinct line still accepted')
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL P0-R2-2 REFERENCE-MATCH TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
