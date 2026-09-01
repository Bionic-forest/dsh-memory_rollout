// 返工复核 P0-3：migrateStage1FromFile 在「表非空即跳过」时旧文件不归档的缺口。
// 修复后：若因 stage1_jobs 表已非空而跳过迁移，须把旧 `.stage1-state.json` 归档为
// `.bak-legacy-<ts>`（不再依赖/不再悬空误导），且不把 legacy 作业导入表。
// 本测试预置：legacy 文件存在 + 表已非空 → apply() 启动迁移必须跳过 + 归档 + 不导入。
// 存储访问：读 dsh_rollout 的 stage1_jobs 表（jobListOf）；旧文件在 memoryRoot() 下。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-polish-mig-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const memoriesDir = path.join(HOME, 'memories')
fs.mkdirSync(memoriesDir, { recursive: true })

// 预置 legacy 文件（旧 `.stage1-state.json`，含一条 legacy 作业 s0::w0）。
const legacyPath = path.join(memoriesDir, '.stage1-state.json')
const legacy = {
  jobs: { 's0::w0': { id: 'j-s0', session_id: 's0', source_watermark: 'w0', status: 'pending', attempt_count: 0, max_attempts: 3, available_at: new Date(Date.now() - 60000).toISOString(), lease_owner: '', lease_expires_at: '', created_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString(), completed_at: '' } },
  outputs: {},
  global: { runDay: '2000-01-01', modelAttemptsToday: 0 },
}
fs.writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8')
check(fs.existsSync(legacyPath), 'precondition: legacy .stage1-state.json exists')

// 预置表为非空（在 apply 之前 seed 一条作业）→ 迁移应跳过（表已有数据）。
const { ctx, domain } = makeCtx({ get: () => undefined })
await seedJob(domain, 'seed', 'wm-seed', { status: 'pending', availableAt: new Date().toISOString() })
check(jobListOf(domain)['seed::wm-seed'], 'precondition: stage1_jobs table already non-empty (seeded)')

await apply(ctx, {})
await new Promise((r) => setTimeout(r, 100))

const archived = fs.readdirSync(memoriesDir).filter((f) => f.startsWith('.stage1-state.json.bak-legacy-'))
console.log('  legacy file present:', fs.existsSync(legacyPath), '| archived files:', archived)
check(!fs.existsSync(legacyPath), 'skip-migration archived the legacy file (original no longer present)')
check(archived.length === 1, 'exactly one .bak-legacy-<ts> archive created')
if (archived.length) {
  const archiveText = fs.readFileSync(path.join(memoriesDir, archived[0]), 'utf8')
  const archiveObj = JSON.parse(archiveText)
  check(archiveObj.jobs && archiveObj.jobs['s0::w0'], 'archived file preserved the legacy job content (audit/rollback)')
}
const jobs = jobListOf(domain)
check(!jobs['s0::w0'], 'legacy job s0::w0 NOT imported (migration skipped because table non-empty)')
check(!!jobs['seed::wm-seed'], 'pre-existing seed job survives apply() (not clobbered)')

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL POLISH MIGRATION-ARCHIVE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
