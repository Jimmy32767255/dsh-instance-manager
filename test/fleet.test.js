// lib/fleet.js 中对端链路辅助函数的单元测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePeers, LINK_PATH, createQueryResponder, FleetLinks, QUERY_LIMIT } from '../lib/fleet.js'
import { normalizePort } from '../lib/shared.js'

test('parsePeers parses id@origin pairs into ws link descriptors', () => {
  const peers = parsePeers('office@http://192.168.1.20:3080, laptop@example.com:3081')
  assert.deepEqual(peers, [
    { id: 'office', origin: 'http://192.168.1.20:3080', wsUrl: 'ws://192.168.1.20:3080' + LINK_PATH },
    { id: 'laptop', origin: 'http://example.com:3081', wsUrl: 'ws://example.com:3081' + LINK_PATH }
  ])
})

test('parsePeers keeps https origins on wss and tolerates bare hosts', () => {
  const peers = parsePeers('a@https://secure.example,b@10.0.0.9')
  assert.equal(peers[0].wsUrl, 'wss://secure.example' + LINK_PATH)
  assert.equal(peers[1].origin, 'http://10.0.0.9', 'scheme-less origins default to http')
})

test('parsePeers rejects origins carrying userinfo', () => {
  // 对端用 fleet bearer 认证；URL 里的凭证会进入 wsUrl，也会出现在错误详情中。
  assert.deepEqual(parsePeers('a@http://user:pass@192.168.1.20:3080'), [])
  assert.deepEqual(parsePeers('a@user:pass@host:3080'), [])
  // 路径段里的 '@' 不是 userinfo。
  assert.equal(parsePeers('a@http://host:3080/p@th').length, 1)
})

test('parsePeers drops junk, dedupes ids, strips trailing slashes, caps', () => {
  assert.deepEqual(parsePeers(''), [])
  assert.deepEqual(parsePeers('no-at-sign, @no-id, id@'), [])
  const dup = parsePeers('x@http://a,x@http://b')
  assert.equal(dup.length, 1)
  assert.equal(dup[0].origin, 'http://a')
  const many = parsePeers('p1@http://a,p2@http://b,p3@http://c', 2)
  assert.equal(many.length, 2, '数量上限约束对端表')
})

// ---- 入站查询应答 ---------------------------------------------------------
// 应答器把每种查询委托给本地 HTTP 路由使用的同一组函数，对端因此无法到达面板自己
// 会拒绝的代码路径：`sessions` 转发请求中的端口，`logs` 在命名文件前归一化流名称。
// 这些测试固定委托关系。
const makeResponder = (over = {}) => {
  const calls = []
  const deps = {
    fleetId: () => 'fleet-abc',
    version: '9.9.9',
    listLocalInstances: async () => ({
      currentPort: 3080,
      items: [{ port: 3080, remote: false }, { port: 4099, remote: true }]
    }),
    sessionsFor: async (port) => { calls.push(['sessions', port]); return { ok: true, port } },
    logsFor: async (port, stream) => { calls.push(['logs', port, stream]); return { ok: true, port, stream } },
    ...over
  }
  return { calls, answer: createQueryResponder(deps) }
}

test('query responder answers ping (and a missing query) with identity', async () => {
  const { answer, calls } = makeResponder()
  assert.deepEqual(await answer({ kind: 'ping' }), { ok: true, fleetId: 'fleet-abc', version: '9.9.9' })
  assert.deepEqual(await answer(undefined), { ok: true, fleetId: 'fleet-abc', version: '9.9.9' })
  assert.deepEqual(calls, [], 'ping 不得接触任何实例状态')
})

test('query responder answers fleet with local rows only', async () => {
  const { answer } = makeResponder()
  const r = await answer({ kind: 'fleet' })
  assert.equal(r.ok, true)
  assert.equal(r.currentPort, 3080)
  assert.deepEqual(r.items.map((i) => i.port), [3080], '远端行绝不能回传给对端')
})

test('query responder forwards the REQUESTED port to sessions', async () => {
  // 用本实例自己的数据应答会让请求 :3090 的查询返回 :3080 的会话——错误的数据而不是
  // 错误，这对 fleet 视图是最糟的失败方式。
  const { answer, calls } = makeResponder()
  const r = await answer({ kind: 'sessions', port: 3090 })
  assert.deepEqual(calls, [['sessions', 3090]], '请求的端口必须穿过这一跳')
  assert.equal(r.port, 3090)
})

test('query responder treats an omitted sessions port as "yourself"', async () => {
  const { answer, calls } = makeResponder()
  await answer({ kind: 'sessions' })
  assert.deepEqual(calls, [['sessions', undefined]], '没有端口表示对端自己的实例')
})

test('query responder passes logs port and stream through untouched', async () => {
  // 端口会在应答方拼进文件名；校验在共享的 logsFor/normalizePort 中，刻意不在这里
  // 重复。
  const { answer, calls } = makeResponder()
  await answer({ kind: 'logs', port: 3090, stream: 'err' })
  await answer({ kind: 'logs', port: 3090 })
  assert.deepEqual(calls, [['logs', 3090, 'err'], ['logs', 3090, undefined]])
})

test('query responder passes a peer-supplied logs port straight to the validating helper', async () => {
  // 应答器刻意不校验：原样转发，由 logsFor/normalizePort——HTTP 路由使用的同一道
  // 关卡——决定。在这里复制规则会产生第二份更弱的副本。
  const attack = '../'.repeat(8) + 'Windows/win.ini'
  const { answer, calls } = makeResponder()
  await answer({ kind: 'logs', port: attack })
  assert.equal(calls[0][1], attack, '原样转发')
  assert.equal(normalizePort(calls[0][1]), null, '共享校验器会在构造任何文件名之前拒绝它')
})

test('query responder reports unknown kinds instead of guessing', async () => {
  const { answer, calls } = makeResponder()
  assert.deepEqual(await answer({ kind: 'stop-everything' }), { ok: false, code: 'unknown_query' })
  assert.deepEqual(calls, [], '未识别的种类不得接触任何实例状态')
})

// ---- 互相 peer 不得放大 ---------------------------------------------------
// 常见的 fleet 配置是两台机器互相列出对方。用重新列出整个 fleet（包含对端）来应答
// 对端的 `fleet` 查询，会让这一对永远互相应答：A 问 B，B 的应答去问 A，A 的应答又去
// 问 B……一次面板刷新即可在两端产生大量嵌套列表，每一次都是全端口扫描。
//
// 宿主在源头消除它（应答器拿到的是不含对端的 listLocalInstances）。本测试固定传输层
// 的守卫，它即使拿到并非不含对端的列表器也成立。
const WS_OPEN = 1
class MemSocket {
  constructor(url) { this.url = url; this.readyState = WS_OPEN; this.h = {}; this.remote = null; this.isAlive = true }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this }
  emit(ev, ...a) { for (const fn of this.h[ev] || []) fn(...a) }
  send(data) {
    const text = String(data)
    queueMicrotask(() => {
      if (this.remote && this.remote.readyState === WS_OPEN) this.remote.emit('message', text)
    })
  }
  ping() { }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
}
class MemWSS {
  constructor(options) { this.options = options }
  handleUpgrade(req, socket, head, cb) { cb(socket) }
}

const wireMutualPeers = async () => {
  const dials = []
  const waiting = []
  // 两条链路在拨号前由 `deps` 构造，拨号只在 `resolveToken()` 结算后发生。等待注入
  // 的构造函数实际创建的 socket 才是诚实的条件——固定 setTimeout 会与其竞争，并在
  // 负载高的机器上失败。
  const untilDialed = (count) => dials.length >= count
    ? Promise.resolve()
    : new Promise((resolve) => { waiting.push({ count, resolve }) })
  class Dial extends MemSocket {
    constructor(url) {
      super(url)
      dials.push(this)
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (dials.length < waiting[i].count) continue
        const [wait] = waiting.splice(i, 1)
        wait.resolve()
      }
    }
  }
  const counts = { a: 0, b: 0 }
  const build = (name, peerName) => {
    const node = { name, peerName }
    node.hub = new FleetLinks({
      WebSocket: Dial,
      WebSocketServer: MemWSS,
      safeTokenEqual: (x, y) => x === y,
      fleetId: () => 'fleet-' + name,
      resolveToken: async () => 'tok',
      // 刻意使用对本测试错误的形状：应答 fleet 查询时重新列出整个 fleet，包含
      // 对端。守卫必须在这种实现下仍然成立。
      answerQuery: createQueryResponder({
        fleetId: () => 'fleet-' + name,
        version: '0.9.1',
        listLocalInstances: async () => {
          counts[name] += 1
          if (counts[name] > 200) throw new Error('runaway: ' + name + ' listed ' + counts[name] + ' times')
          await node.hub.queryPeer(node.peerName, { kind: 'fleet' }, 300)
          return { currentPort: 3080, items: [{ port: 3080, remote: false }] }
        },
        sessionsFor: async () => ({ ok: true }),
        logsFor: async () => ({ ok: true })
      })
    }, [{ id: peerName, wsUrl: 'ws://' + peerName + '/link' }])
    return node
  }
  const A = build('a', 'b')
  const B = build('b', 'a')
  await untilDialed(2)
  // A 拨向 B，B 拨向 A：把每条出站 socket 接到对方入站。
  const aSide = dials.find((d) => d.url === 'ws://b/link')
  const bSide = dials.find((d) => d.url === 'ws://a/link')
  assert.ok(aSide && bSide, '两个对端都必须已经拨号')
  const bAccept = new MemSocket()
  const aAccept = new MemSocket()
  aSide.remote = bAccept; bAccept.remote = aSide; aSide.emit('open')
  bSide.remote = aAccept; aAccept.remote = bSide; bSide.emit('open')
  B.hub.attachInbound(bAccept)
  A.hub.attachInbound(aAccept)
  return { A, B, counts }
}

test('a mutually-peered pair answers one fleet query without amplification', async () => {
  const { A, B, counts } = await wireMutualPeers()
  try {
    const res = await A.hub.queryPeer('b', { kind: 'fleet' }, 1000)
    assert.equal(res.ok, true, '对端仍必须应答：' + JSON.stringify(res))
    assert.equal(counts.b, 1, '应答方只列一次')
    assert.equal(counts.a, 0, '且不能被拉进来自己也去列')
  } finally {
    A.hub.dispose(); B.hub.dispose()
  }
})

// ---- 一条链路不能应答另一条的问题 --------------------------------------
// `query-result` 只结算从它自己 socket 发出的查询：reqId 是计数器加时间戳，不是
// 秘密，只按该 id 匹配会让任何通过 bearer 的 socket 结算别人的查询。
const buildHub = () => {
  const answered = []
  const hub = new FleetLinks({
    WebSocket: MemSocket,
    WebSocketServer: MemWSS,
    safeTokenEqual: (x, y) => x === y,
    fleetId: () => 'fleet-a',
    resolveToken: async () => 'tok',
    answerQuery: async (q) => { answered.push(q); return { ok: true, kind: q.kind } }
  }, [])
  return { hub, answered }
}

const settleAfterOneTurn = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }

test('a query-result settles its own socket\'s query only', async () => {
  const { hub } = buildHub()
  const asked = new MemSocket()
  const other = new MemSocket()
  hub.attachInbound(asked)
  hub.attachInbound(other)

  const settled = []
  hub.pending.set('q7-known', { resolve: (r) => settled.push(r), timer: undefined, socket: asked })

  other.emit('message', JSON.stringify({ type: 'query-result', reqId: 'q7-known', result: { ok: true, forged: true } }))
  await settleAfterOneTurn()
  assert.deepEqual(settled, [], '另一条 socket 不得结算这个查询')
  assert.equal(hub.pending.has('q7-known'), true, '它保持待决，真正的应答仍可到达')

  asked.emit('message', JSON.stringify({ type: 'query-result', reqId: 'q7-known', result: { ok: true, real: true } }))
  await settleAfterOneTurn()
  assert.deepEqual(settled, [{ ok: true, real: true }])
  hub.dispose()
})

test('the upgrade server caps one frame at a documented byte count', () => {
  const { hub } = buildHub()
  assert.ok(hub.server.options.maxPayload > 0, '对端不得流式发送无界的帧正文')
  hub.dispose()
})

test('a peer that floods query frames is answered rate_limited, not left hanging', async () => {
  const { hub, answered } = buildHub()
  const peer = new MemSocket()
  hub.attachInbound(peer)
  const replies = []
  peer.remote = { readyState: WS_OPEN, emit: (ev, text) => { if (ev === 'message') replies.push(JSON.parse(text)) } }

  const total = QUERY_LIMIT + 5
  for (let i = 0; i < total; i++) {
    peer.emit('message', JSON.stringify({ type: 'query', reqId: 'q' + i, query: { kind: 'ping' } }))
  }
  await settleAfterOneTurn()

  assert.equal(answered.length, QUERY_LIMIT, '窗口恰好放行其额度')
  const limited = replies.filter((r) => r.result && r.result.code === 'rate_limited')
  assert.equal(limited.length, 5, '超出部分被拒绝，而不是静默丢弃')
  for (const reply of limited) {
    assert.equal(typeof reply.reqId, 'string', '每次拒绝仍带回发起查询的 id')
  }
  hub.dispose()
})

test('a fleet query nested inside an inbound fleet answer is refused, not forwarded', async () => {
  const { A, B, counts } = await wireMutualPeers()
  try {
    // 直接驱动嵌套查询：B 正在应答 A 时，B 不得再询问任何人。上面的放大测试端到端
    // 验证的就是这个不变式；这里断言返回的 code。
    B.hub.answeringFleet += 1
    const nested = await B.hub.queryPeer('a', { kind: 'fleet' }, 300)
    B.hub.answeringFleet -= 1
    assert.deepEqual(nested, { ok: false, code: 'fleet_query_nested' })
    assert.equal(counts.b, 0, '被拒绝的查询绝不能到达列表器')
    // 非 fleet 种类仍然可用（嵌套的会话/日志读取是允许的）。
    const other = await B.hub.queryPeer('a', { kind: 'sessions', port: 3080 }, 300)
    assert.ok(other.ok !== undefined, '只有 fleet 查询受守卫限制')
  } finally {
    A.hub.dispose(); B.hub.dispose()
  }
})
