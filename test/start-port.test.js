// 自动端口选择。
//
// 选取器必须跳过上一次尝试失败的端口；候选端口要靠真实绑定确认，而不是只确认没有
// 连接应答——失败子进程的监听器可能尚未结算，扫描会短暂把该端口报告为空闲。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickStartPort, retryableStart, startOnceOrRetry } from '../lib/shared.js'

const range = { min: 3080, max: 3084 }

test('the picker skips the port the previous attempt died on', async () => {
  const asked = []
  const port = await pickStartPort({
    range,
    exclude: 3080,
    available: async (p) => { asked.push(p); return true }
  })
  assert.equal(port, 3081)
  assert.deepEqual(asked, [3081], 'the excluded port is never even probed')
})

test('the picker takes the first port whose availability check passes', async () => {
  const free = new Set([3082, 3083])
  const port = await pickStartPort({ range, available: async (p) => free.has(p) })
  assert.equal(port, 3082)
})

test('an unavailable every port answers 0, never a port that failed its check', async () => {
  const port = await pickStartPort({ range, available: async () => false })
  assert.equal(port, 0)
})

test('only the excluded port being free still answers 0 rather than reusing it', async () => {
  const port = await pickStartPort({ range, exclude: 3080, available: async (p) => p === 3080 })
  assert.equal(port, 0, 're-picking the port that just failed is the loop this guards')
})

// ---- START 可以派生几次 ----------------------------------------------------
//
// 重试只保护一种情况（子进程在自动选取的端口上退出），绝不能演变成比它修复的问题更
// 严重的两种失败：在调用方没指定的端口上启动，以及重复派生一个启动较慢的实例。
const launches = (results) => {
  const seen = []
  const launch = async (options) => {
    seen.push(options === undefined ? undefined : { ...options })
    return results[seen.length - 1]
  }
  return { launch, seen }
}

test('a dead child on an auto-picked port retries once, skipping that port', async () => {
  const { launch, seen } = launches([
    { ok: false, code: 'start_failed', port: 3081, error: 'child exited' },
    { ok: true, port: 3082, pid: 99 }
  ])
  const r = await startOnceOrRetry(launch, { browserHandoff: true })
  assert.equal(r.ok, true)
  assert.equal(r.port, 3082)
  assert.equal(seen.length, 2, 'exactly one retry')
  assert.equal(seen[1].excludePort, 3081, 'the second attempt must not re-pick the dead port')
  assert.equal(seen[1].browserHandoff, true, 'the caller options survive the retry')
})

test('a merely slow boot is never retried: the child may still be coming up', async () => {
  const { launch, seen } = launches([{ ok: false, code: 'start_unconfirmed', port: 3081, pid: 42 }])
  const r = await startOnceOrRetry(launch, undefined)
  assert.equal(r.code, 'start_unconfirmed', 'the verdict is reported as-is')
  assert.equal(seen.length, 1, 'a second spawn would leave two live instances')
})

test('a named port is never retried elsewhere', async () => {
  const { launch, seen } = launches([{ ok: false, code: 'start_failed', port: 4000, error: 'child exited' }])
  const r = await startOnceOrRetry(launch, { port: 4000 })
  assert.equal(r.code, 'start_failed')
  assert.equal(seen.length, 1, 'retrying would start an instance the caller did not ask for')
})

test('a second failure reports both attempts', async () => {
  const { launch, seen } = launches([
    { ok: false, code: 'start_failed', port: 3081, error: 'first died' },
    { ok: false, code: 'start_failed', port: 3082, error: 'second died' }
  ])
  const r = await startOnceOrRetry(launch, undefined)
  assert.equal(seen.length, 2)
  assert.equal(r.ok, false)
  assert.match(r.error, /first died/)
  assert.match(r.error, /重试仍失败/)
})
