// 阶段 A · 总纲 §14「phase1-source-watermark」：内容水印在入队层的去重/防漏语义。
// 同 session 同内容 -> 不重复建 job；同 session 不同内容（新活动）-> 建新 job。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { enqueueStage1JobFile, contentWatermark } = await import(PLUGIN)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swm-'))
const p = path.join(dir, '.stage1-state.json')
const readJobs = () => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).jobs || {} } catch { return {} } }
const rawA = 'the user prefers powershell for shell tasks today'
const rawB = 'the user prefers powershell for shell tasks and also likes ghidra'
const wmA = contentWatermark(rawA)
const wmB = contentWatermark(rawB)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  console.log('[1] same session + same content -> same job (dedupe, no runaway)')
  {
    const a = enqueueStage1JobFile(p, 's1', wmA, new Date())
    const b = enqueueStage1JobFile(p, 's1', wmA, new Date())
    check(a.queued === true && b.queued === false, 'second identical enqueue is a no-op')
    const jobs = readJobs()
    check(Object.keys(jobs).filter((k) => k.startsWith('s1::')).length === 1, 'exactly one s1 job (deduped)')
  }

  console.log('[2] same session + NEW content -> new job (new activity not missed)')
  {
    const c = enqueueStage1JobFile(p, 's1', wmB, new Date())
    check(c.queued === true, 'new content enqueued a second job')
    const jobs = readJobs()
    check(Object.keys(jobs).filter((k) => k.startsWith('s1::')).length === 2, 'two s1 jobs (old + new watermark)')
    check(wmA !== wmB, 'different content -> different watermark')
  }
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE1-SOURCE-WATERMARK TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
