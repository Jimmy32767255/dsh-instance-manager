// `dsh-host-http` 块在本仓库中的运行方式。
//
// 这里断言两件事：(1) 该块只嵌入一次且顺序正确——`check` 只比较它固定版本的 dock
// 认识的标记，因此缺失、重复或错位由本文件发现；(2) 本插件发布的应答策略仍由导出的
// 函数产生，包括名称、pid 与会话摘要等正文上的 `cache-control: no-store`，以及带
// 被拒绝 `action` 回显的 `need_post` 措辞。
//
// 下面的每个用例都 CALL 导出函数。把 lib/index.js 当字符串匹配不能证明模块加载本身
// 没有证明的事——导入失败会在任何断言运行前让文件失败——因此“宿主侧配置共享工厂、
// 不保留私有副本”这项保证由 test/routes.test.js 的挂载路由用例承担，它们通过本插件
// 真实的 requirePost、authorizeBrowser 与 sendJson 绑定应答。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sendJson,
  createRequirePost,
  createBrowserAuthorizer,
  connectionUnavailable,
  CONNECTION_UNAVAILABLE
} from '../lib/shared.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sharedSource = readFileSync(path.join(ROOT, 'lib', 'shared.js'), 'utf8')

// `sendJson` 写入状态与响应头并结束响应，因此两个方法的桩就是全部契约——也是观察
// 响应头的唯一方式，而这些路由正是按响应头来判定的。
const fakeRes = () => {
  const written = []
  return {
    written,
    writeHead: (status, headers) => written.push({ status, headers }),
    end: (body) => written.push({ body })
  }
}
const replied = (res) => ({
  status: res.written[0].status,
  headers: res.written[0].headers,
  json: JSON.parse(res.written.find((w) => w.body !== undefined).body)
})

const openMarker = (name) => sharedSource.split(`// <${name}>`).length - 1
const closeMarker = (name) => sharedSource.split(`// </${name}>`).length - 1

test('dsh-host-http is embedded exactly once, below the guard it sits under', () => {
  assert.equal(openMarker('dsh-host-http'), 1, '恰好一个起始标记')
  assert.equal(closeMarker('dsh-host-http'), 1, '恰好一个结束标记')
  // 文件中的块顺序必须与 dock CLI 拼接的片段顺序一致（loopback -> guard ->
  // host-http）；顺序错乱的文件会让 `check` 在下一个块下面重写一个块。
  const at = (name) => sharedSource.indexOf(`// <${name}>`)
  assert.ok(at('dsh-loopback-helpers') < at('dsh-host-guard'), 'loopback 在 guard 之上')
  assert.ok(at('dsh-host-guard') < at('dsh-host-http'), 'guard 在 host-http 之上')
  for (const name of ['dsh-loopback-helpers', 'dsh-host-guard', 'dsh-host-http']) {
    assert.ok(at(name) > -1, `${name} 存在`)
  }
})

test('sendJson answers with no-store, on every route that names host facts', () => {
  const res = fakeRes()
  sendJson(res, 200, { ok: true, items: [{ port: 3080, pid: 4242 }] })
  const r = replied(res)
  assert.equal(r.status, 200)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.match(r.headers['content-type'], /application\/json/)
  assert.equal(r.json.items[0].port, 3080)
})

test('the POST gate keeps this plugin\'s published 405 vocabulary through policy', () => {
  const requirePost = createRequirePost({
    policy: { method_not_allowed: { code: 'need_post', error: '{action} 需要 POST 请求', includeAction: true } }
  })
  const res = fakeRes()
  assert.equal(requirePost({ method: 'GET' }, res, 'stop-all'), false)
  const r = replied(res)
  assert.equal(r.status, 405)
  assert.equal(r.headers['cache-control'], 'no-store', '入口通过同一套策略应答')
  assert.equal(r.json.code, 'need_post', '本插件一直发布的 code')
  assert.equal(r.json.action, 'stop-all', '被拒绝的 action 仍被回显')
  assert.equal(r.json.error, 'stop-all 需要 POST 请求')
  assert.equal(requirePost({ method: 'POST' }, fakeRes(), 'stop-all'), true)
})

test('the gate\'s defaults and its validation are the block\'s, not a local fork', () => {
  const plain = createRequirePost()
  const res = fakeRes()
  assert.equal(plain({ method: 'GET' }, res, 'kill'), false)
  assert.equal(replied(res).json.code, 'method', '片段默认值')
  assert.equal(replied(res).json.action, undefined, '未经策略要求时不回显 action')
  assert.equal(replied(res).headers['cache-control'], 'no-store',
    '没有传 `respond` 时，拒绝仍经过本块的 sendJson')
  // 部分覆盖与默认值合并而不是替换，只改 code 的插件不会得到空消息。
  const merged = fakeRes()
  const onlyCode = createRequirePost({ policy: { method_not_allowed: { code: 'own_code' } } })
  assert.equal(onlyCode({ method: 'DELETE' }, merged, 'restart'), false)
  assert.equal(replied(merged).json.code, 'own_code')
  assert.equal(replied(merged).json.error, 'action "restart" requires POST', '默认措辞保留')
  // 策略键名拼错必须报错而不是静默使用默认值，否则插件会发布一个没有测试预期的
  // code。
  assert.throws(() => createRequirePost({ policy: { wrong_key: { code: 'x' } } }), /unknown policy key/)
  // 方法按大小写不敏感读取，缺失时读作 GET——这是刻意保留的宽松读法（见
  // lib/index.js 绑定处的说明）。test/routes.test.js 在挂载路由上固定同一判定，
  // 而不是在源码字符串上。
  assert.equal(plain({ method: 'post' }, fakeRes(), 'kill'), true)
  assert.equal(plain({}, fakeRes(), 'kill'), false)
})

test('connectionUnavailable writes through the default sendJson', () => {
  assert.equal(CONNECTION_UNAVAILABLE.code, 'connection_unavailable')
  assert.ok(Object.isFrozen(CONNECTION_UNAVAILABLE), '常量已冻结：每个调用点共用一份措辞')
  const res = fakeRes()
  assert.equal(connectionUnavailable(res), false,
    '返回 false，调用方可以在一条语句里交回自己的判定')
  const r = replied(res)
  assert.equal(r.status, 503)
  assert.deepEqual(r.json, { ok: false, code: 'connection_unavailable', error: 'browser authentication unavailable' })
  assert.equal(r.headers['cache-control'], 'no-store',
    'no-store 策略不是调用点可以遗漏的')
})

test('an injected sink reaches every 503 path, and the body handed out is a copy', () => {
  const written = []
  const respond = (res, status, body) => written.push({ res, status, body })
  const res = { which: 'injected' }
  assert.equal(connectionUnavailable(res, respond), false)
  assert.equal(written.length, 1)
  assert.equal(written[0].res, res, '与守卫块相同的 (res, status, body) 接收形状')
  assert.equal(written[0].status, 503)
  assert.notEqual(written[0].body, CONNECTION_UNAVAILABLE, '调用方收到副本，绝不是冻结对象')
  assert.deepEqual(written[0].body, { ...CONNECTION_UNAVAILABLE })
  // 授权器把同一个接收器传给两条 503 路径，自行组合应答的路由也无法丢掉共享措辞。
  const thrown = createBrowserAuthorizer({
    getConnection: () => ({ requestRejection: () => { throw new Error('disposed') } }),
    getConnectionSeen: () => false,
    guard: () => true,
    respond
  })
  assert.equal(thrown({}, res), false)
  const gap = createBrowserAuthorizer({
    getConnection: () => null,
    getConnectionSeen: () => true,
    guard: () => true,
    respond
  })
  assert.equal(gap({}, res), false)
  assert.equal(written.length, 3, 'both 503s went to the injected sink, not to sendJson')
  assert.deepEqual(written.slice(1).map((w) => w.status), [503, 503])
  assert.deepEqual(written[1].body, { ...CONNECTION_UNAVAILABLE })
})

// 授权器的判定顺序本身就是安全属性，宿主侧将它接到两个会在服务重载时重新赋值的闭包
// 变量上。取值函数因此是关键：捕获的值会继续依据已释放的 Connection 授权。
const authorizerCase = ({ connection = null, seen = false, guardVerdict = true, throwing = false } = {}) => {
  const guardCalls = []
  const res = fakeRes()
  const authorize = createBrowserAuthorizer({
    getConnection: () => connection,
    getConnectionSeen: () => seen,
    guard: (req, r) => { guardCalls.push(req); return guardVerdict }
  })
  let outcome
  try {
    outcome = authorize({ method: 'GET', url: '/x' }, res)
  } catch (e) {
    if (!throwing) throw e
  }
  return { outcome, res, guardCalls, replied: res.written.length ? replied(res) : null }
}

test('the authorizer validates the seams that would otherwise go stale', () => {
  assert.throws(() => createBrowserAuthorizer({ getConnection: null, getConnectionSeen: () => false, guard: () => true }),
    /getConnection must be an accessor/)
  assert.throws(() => createBrowserAuthorizer({ getConnection: () => null, getConnectionSeen: false, guard: () => true }),
    /getConnectionSeen must be an accessor/)
  assert.throws(() => createBrowserAuthorizer({ getConnection: () => null, getConnectionSeen: () => false }),
    /guard is required/)
})

test('a Connection that throws is not a Connection that permits', () => {
  const seen = []
  const res = fakeRes()
  const authorize = createBrowserAuthorizer({
    getConnection: () => ({ requestRejection: () => { throw new Error('disposed') } }),
    getConnectionSeen: () => true,
    guard: (req) => { seen.push(req); return true }
  })
  assert.equal(authorize({ method: 'GET' }, res), false)
  assert.equal(replied(res).status, 503)
  assert.equal(replied(res).json.code, 'connection_unavailable')
  assert.deepEqual(seen, [], '且绝不能落到守卫或处理器')
})

test('a Connection rejection code is final, and only 401 reads as unauthorized', () => {
  for (const [code, expected] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const res = fakeRes()
    const authorize = createBrowserAuthorizer({
      getConnection: () => ({ requestRejection: () => code }),
      getConnectionSeen: () => true,
      guard: () => true
    })
    assert.equal(authorize({}, res), false, code)
    assert.equal(replied(res).status, code, code)
    assert.equal(replied(res).json.code, expected, code)
  }
  const ok = fakeRes()
  const authorize = createBrowserAuthorizer({
    getConnection: () => ({ requestRejection: () => undefined }),
    getConnectionSeen: () => false,
    guard: () => false
  })
  assert.equal(authorize({}, ok), true, '没有拒绝意味着浏览器可以继续')
})

test('a reload gap answers 503 rather than reopening the route through the guard', () => {
  const case1 = authorizerCase({ connection: null, seen: true, guardVerdict: true })
  assert.equal(case1.outcome, false)
  assert.equal(case1.replied.status, 503)
  assert.deepEqual(case1.guardCalls, [], '不咨询更弱的回环围栏')
  // RC1 之前的主机：从未有过 Connection，插件守卫就是边界。
  const case2 = authorizerCase({ connection: null, seen: false, guardVerdict: false })
  assert.equal(case2.outcome, false)
  assert.equal(case2.guardCalls.length, 1, '这里由守卫决定')
  assert.equal(case2.replied, null, '应答来自守卫，不是本块')
})
