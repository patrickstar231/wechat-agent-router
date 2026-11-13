// dsh-wechat-agent-router：路由纯函数 + 包装层 + 配置读取。
//
// 包装层用「假 apiProxy」测（形如 dsh-host-apiproxy 的真实结构：普通对象 + 方法），
// 配置读取用 WECHAT_ROUTER_SETTINGS 指向临时 yaml，绝不碰用户真实 settings.yaml。
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createGroupResolver,
  describeRoutes,
  matchRule,
  normalizeRules,
  routeFor,
  sessionIdFor,
} from '../lib/router.js'
import { createConfigSnapshot, readRouterConfig, readWechatGroups } from '../lib/settings-file.js'
import { installSessionRouting, reconcileBlankSessions, unwrap } from '../lib/wrap.js'

const tempDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'wr-'))

// ── 1. 路由纯函数 ──────────────────────────────────────────────────────────────

test('sessionIdFor 与 dsh-wechat-assistant 的实现逐字节一致', () => {
  // 这个 id 是群会话的持久身份：两边算法一旦漂移，历史会话就会变孤儿、路由也会静默失效，
  // 所以这里用固定字面量锁住（改动它必须同步改 src/bridge.ts 并接受会话迁移）。
  assert.equal(sessionIdFor('测试群'), 'wechat-group-2830e9218f1840cbbbfb11d872c01629')
  assert.equal(sessionIdFor('京源对接群'), 'wechat-group-3fc810fa605ce67a7f3b1f799dd504ab')
  assert.equal(sessionIdFor('  带空格  '), sessionIdFor('带空格'), '两端都 trim，必须对齐 bridge.ts 的 body.group.trim()')
})

test('规则归一：丢掉空 match / 空 agent，未知 mode 退回 contains', () => {
  assert.deepEqual(normalizeRules([
    { match: '对接', agent: 'iot' },
    { match: '', agent: 'iot' },
    { match: 'x', agent: '' },
    { match: ' y ', mode: 'exact', agent: ' iot ' },
    { match: 'z', mode: '乱写', agent: 'eli-mode' },
    null,
    'nope',
  ]), [
    { match: '对接', mode: 'contains', agent: 'iot' },
    { match: 'y', mode: 'exact', agent: 'iot' },
    { match: 'z', mode: 'contains', agent: 'eli-mode' },
  ])
  assert.deepEqual(normalizeRules(undefined), [])
})

test('匹配：contains 不区分大小写且是子串，exact 要求完全相等', () => {
  assert.equal(matchRule({ match: '对接', mode: 'contains' }, '京源对接群'), true)
  assert.equal(matchRule({ match: 'siot', mode: 'contains' }, 'SIoT平台对接'), true)
  assert.equal(matchRule({ match: '京源对接群', mode: 'exact' }, '京源对接群（新）'), false)
  assert.equal(matchRule({ match: '京源对接群', mode: 'exact' }, '京源对接群'), true)
  assert.equal(matchRule({ match: '对接', mode: 'contains' }, '   '), false)
})

test('routeFor：自上而下第一条命中；都没命中用兜底；关掉开关则完全不干预', () => {
  const config = {
    enabled: true,
    defaultAgent: 'eli-mode',
    rules: [
      { match: '对接', mode: 'contains', agent: 'iot' },
      { match: '测试群', mode: 'exact', agent: 'wechat' },
    ],
  }
  assert.equal(routeFor(config, '京源对接群'), 'iot')
  assert.equal(routeFor(config, '对接测试群'), 'iot', '先命中的规则优先')
  assert.equal(routeFor(config, '测试群'), 'wechat')
  assert.equal(routeFor(config, '随便一个群'), 'eli-mode', '兜底')
  assert.equal(routeFor({ ...config, defaultAgent: '' }, '随便一个群'), '', '兜底为空 = 不干预')
  assert.equal(routeFor({ ...config, enabled: false }, '京源对接群'), '', '总开关关闭')
  assert.equal(routeFor(null, '京源对接群'), '')
  assert.equal(routeFor(config, ''), '')
})

test('createGroupResolver：只认群会话前缀，索引未命中返回 null', () => {
  const resolve = createGroupResolver(['京源对接群', '测试群', '', '  测试群  '])
  assert.equal(resolve(sessionIdFor('京源对接群')), '京源对接群')
  assert.equal(resolve(sessionIdFor('测试群')), '测试群', 'trim 后去重')
  assert.equal(resolve(sessionIdFor('没登记过的群')), null)
  assert.equal(resolve('some-other-session'), null, '非群会话前缀一律不管')
  assert.equal(resolve(undefined), null)
})

test('describeRoutes：给出每个群的目标与命中的规则（UI 预览用）', () => {
  const config = {
    enabled: true,
    defaultAgent: '',
    rules: [{ match: '对接', mode: 'contains', agent: 'iot' }],
  }
  assert.deepEqual(describeRoutes(config, ['京源对接群', '闲聊群', '']), [
    { group: '京源对接群', agent: 'iot', matched: { match: '对接', mode: 'contains', agent: 'iot' } },
    { group: '闲聊群', agent: '', matched: null },
  ])
  assert.deepEqual(describeRoutes({ ...config, enabled: false }, ['京源对接群']), [
    { group: '京源对接群', agent: '', matched: null },
  ])
})

// ── 2. 包装层 ──────────────────────────────────────────────────────────────────

/**
 * 假宿主服务：与 DSH 0.2.2-rc.1 的真实契约一致。
 *   - sessions.create(request, signal?) 直接收请求对象（不再包 { rpcId, payload } 信封）；
 *   - sessions.list() 直接返回 { items }（不再包 { result: { ok, value } }）；
 *   - sessions.resolveAgent(sessionId) 返回 agent 对象；
 *   - agentPresets.select(agent, agentPreset) 第一个参数是 agent 对象。
 * 服务是普通对象 + 方法（与旧 apiProxy 一样可安全替换），并把每次调用记下来。
 */
function fakeServices(items = [], { selectImpl } = {}) {
  const calls = { create: [], select: [], list: 0 }
  const sessions = {
    create: async (request, signal) => {
      calls.create.push(request)
      return { sessionId: request.sessionId, agentPreset: request.agentPreset }
    },
    list: async () => {
      calls.list += 1
      return { items }
    },
    resolveAgent: async (sessionId) => ({ sessionId, id: sessionId }),
  }
  const agentPresets = {
    select: async (agent, agentPreset) => {
      calls.select.push({ sessionId: agent?.sessionId, agentPreset })
      if (selectImpl) return selectImpl(agent, agentPreset)
      return { agentPreset }
    },
  }
  return { sessions, agentPresets, calls }
}

/** 旧别名：包装层测试历史上叫 fakeApiProxy，这里保留名字减少改动噪音。 */
const fakeApiProxy = fakeServices

const routing = (config) => (payload) => {
  const resolver = createGroupResolver(['京源对接群', '闲聊群'])
  const group = resolver(payload?.sessionId)
  if (group === null) return null
  const agent = routeFor(config, group)
  return agent === '' ? null : { group, agent }
}

test('包装 sessions.create：把路由算出的预设写进创建参数', async () => {
  const { sessions, calls } = fakeServices()
  const installed = installSessionRouting({
    sessions,
    resolveRoute: routing({ enabled: true, defaultAgent: '', rules: [{ match: '对接', mode: 'contains', agent: 'iot' }] }),
  })
  assert.equal(installed.installed, true)

  // 新模型：create 直接收 request 对象（含 sessionId / workspaceId / agentPreset），不包信封。
  await sessions.create({ sessionId: sessionIdFor('京源对接群'), workspaceId: 'w', agentPreset: 'wechat' })
  assert.equal(calls.create[0].agentPreset, 'iot', '命中规则 → 改写')
  assert.equal(calls.create[0].workspaceId, 'w', '其它字段原样带过去')

  await sessions.create({ sessionId: sessionIdFor('闲聊群'), workspaceId: 'w', agentPreset: 'wechat' })
  assert.equal(calls.create[1].agentPreset, 'wechat', '没命中 → 不动')

  await sessions.create({ sessionId: 'other-session', workspaceId: 'w', agentPreset: 'wechat' })
  assert.equal(calls.create[2].agentPreset, 'wechat', '非群会话 → 不动')

  await sessions.create({ sessionId: sessionIdFor('京源对接群'), workspaceId: 'w', agentPreset: 'iot' })
  assert.equal(calls.create[3].agentPreset, 'iot', '已经是目标预设 → 不动（避免无谓改写）')

  installed.restore()
  await sessions.create({ sessionId: sessionIdFor('京源对接群'), workspaceId: 'w', agentPreset: 'wechat' })
  assert.equal(calls.create[4].agentPreset, 'wechat', 'restore 后回归原样')
})

test('包装安装是幂等的，且路由函数抛错时放行原始调用（绝不阻断消息）', async () => {
  const { sessions, calls } = fakeServices()
  assert.equal(installSessionRouting({ sessions, resolveRoute: () => null }).installed, true)
  assert.equal(installSessionRouting({ sessions, resolveRoute: () => null }).already, true, '第二次安装是空操作')

  const warned = []
  const proxy = fakeServices()
  installSessionRouting({ sessions: proxy.sessions, resolveRoute: () => { throw new Error('故意炸') }, warn: (message) => warned.push(message) })
  await proxy.sessions.create({ sessionId: sessionIdFor('京源对接群'), agentPreset: 'wechat' })
  assert.equal(proxy.calls.create[0].agentPreset, 'wechat', '异常时按原参数创建')
  assert.equal(warned.length, 1, '并记一条 warn')
})

test('宿主 sessions 服务形状不对时明确报告未安装，而不是抛错', () => {
  assert.equal(installSessionRouting({ sessions: undefined, resolveRoute: () => null }).installed, false)
  assert.equal(installSessionRouting({ sessions: {}, resolveRoute: () => null }).reason, 'sessions 服务不可用')
})

test('补正：只切「空白且预设不对」的群会话，其余一律跳过', async () => {
  const config = { enabled: true, defaultAgent: '', rules: [{ match: '对接', mode: 'contains', agent: 'iot' }] }
  const row = (over) => ({ sessionId: sessionIdFor('京源对接群'), agentPreset: 'wechat', blank: true, running: false, ...over })

  // 一个待补正 + 一个没命中规则 + 一个不属于任何监听群
  const first = fakeServices([
    row(),
    { sessionId: sessionIdFor('闲聊群'), agentPreset: 'wechat', blank: true, running: false },
    { sessionId: 'wechat-group-0000000000000000000000000000dead', agentPreset: 'wechat', blank: true, running: false },
  ])
  const applied = await reconcileBlankSessions({ sessions: first.sessions, agentPresets: first.agentPresets, resolveRoute: routing(config) })
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.applied, [{ group: '京源对接群', agent: 'iot', previous: 'wechat' }])
  // 新模型：select(agent, preset) 两参，agent 由 resolveAgent 解析而来（携带 sessionId）。
  assert.deepEqual(first.calls.select, [{ sessionId: sessionIdFor('京源对接群'), agentPreset: 'iot' }], '只对那一个发起 select')

  // 已有历史：DSH 不允许换预设，只记 skipped
  const history = fakeServices([row({ blank: false })])
  const skipped = await reconcileBlankSessions({ sessions: history.sessions, agentPresets: history.agentPresets, resolveRoute: routing(config) })
  assert.equal(skipped.applied.length, 0)
  assert.match(skipped.skipped[0].reason, /已有历史/)
  assert.equal(history.calls.select.length, 0, '不许对已有历史的会话发起 select')

  // 正在处理消息：跳过（此时 select 也可能撞上 running）
  const running = fakeServices([row({ running: true })])
  const busy = await reconcileBlankSessions({ sessions: running.sessions, agentPresets: running.agentPresets, resolveRoute: routing(config) })
  assert.match(busy.skipped[0].reason, /正在处理/)
  assert.equal(running.calls.select.length, 0)
})

test('补正：select 失败只记 failed，不抛错；锁定码按 agent-preset/locked 识别；服务缺失时明确报告', async () => {
  const { sessions, agentPresets } = fakeServices(
    [{ sessionId: sessionIdFor('京源对接群'), agentPreset: 'wechat', blank: true, running: false }],
    { selectImpl: async () => { throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' }) } },
  )
  const result = await reconcileBlankSessions({
    sessions,
    agentPresets,
    resolveRoute: routing({ enabled: true, defaultAgent: '', rules: [{ match: '对接', mode: 'contains', agent: 'iot' }] }),
  })
  assert.equal(result.ok, true)
  // 锁定的空白会话按约定跳过（不算 failed），不抛错。
  assert.equal(result.applied.length, 0)
  assert.equal(result.failed.length, 0)
  assert.match(result.skipped[0].reason, /不允许换预设|已开始/)

  const missing = await reconcileBlankSessions({ sessions: undefined, resolveRoute: () => null })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /sessions/)
})

test('unwrap：旧信封 ok 为真取 value、否则抛错；新模型（值直返）原样返回', () => {
  assert.deepEqual(unwrap({ result: { ok: true, value: { a: 1 } } }), { a: 1 })
  assert.throws(() => unwrap({ result: { ok: false, error: { message: 'boom' } } }), /boom/)
  // 新模型：服务直接返回值，unwrap 原样返回（不再把 undefined 当失败）。
  assert.deepEqual(unwrap({ a: 1 }), { a: 1 })
  assert.equal(unwrap(undefined), undefined)
})

// ── 3. 配置读取 ────────────────────────────────────────────────────────────────

async function withSettingsFile(content) {
  const dir = await tempDir()
  const file = path.join(dir, 'settings.yaml')
  await fsp.writeFile(file, content, 'utf8')
  process.env.WECHAT_ROUTER_SETTINGS = file
  return { dir, file }
}

test('读配置：本插件的段补齐默认值，同事的 groups 支持数组与分号字符串', async () => {
  const { dir } = await withSettingsFile([
    'wechat-agent-router:',
    '  defaultAgent: eli-mode',
    '  rules:',
    '    - match: 对接',
    '      agent: iot',
    'wechat-assistant:',
    '  groups:',
    '    - 京源对接群',
    '    - 闲聊群',
    '  workspace: C:\\wcf-bot',
    '',
  ].join('\n'))
  try {
    const config = readRouterConfig()
    assert.equal(config.enabled, true, '缺字段补默认')
    assert.equal(config.defaultAgent, 'eli-mode')
    assert.deepEqual(config.rules, [{ match: '对接', mode: 'contains', agent: 'iot' }])
    assert.deepEqual(readWechatGroups(), ['京源对接群', '闲聊群'])
  } finally {
    delete process.env.WECHAT_ROUTER_SETTINGS
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('读配置：文件缺失 / 段缺失 / groups 是分号字符串都不炸', async () => {
  const { dir } = await withSettingsFile('wechat-assistant:\n  groups: "A;B；C"\n')
  try {
    assert.deepEqual(readRouterConfig(), { enabled: true, defaultAgent: '', rules: [] })
    assert.deepEqual(readWechatGroups(), ['A', 'B', 'C'])
  } finally {
    delete process.env.WECHAT_ROUTER_SETTINGS
    await fsp.rm(dir, { recursive: true, force: true })
  }

  process.env.WECHAT_ROUTER_SETTINGS = path.join(os.tmpdir(), 'wr-does-not-exist.yaml')
  try {
    assert.deepEqual(readWechatGroups(), [])
    assert.equal(readRouterConfig().enabled, true)
  } finally {
    delete process.env.WECHAT_ROUTER_SETTINGS
  }
})

test('配置快照：缓存到期前不重读，invalidate 后立刻反映新配置', async () => {
  const { dir, file } = await withSettingsFile('wechat-agent-router:\n  defaultAgent: iot\n')
  try {
    const snapshot = createConfigSnapshot(60_000)
    assert.equal(snapshot.get().config.defaultAgent, 'iot')

    await fsp.writeFile(file, 'wechat-agent-router:\n  defaultAgent: eli-mode\n', 'utf8')
    assert.equal(snapshot.get().config.defaultAgent, 'iot', 'TTL 内用缓存')
    snapshot.invalidate()
    assert.equal(snapshot.get().config.defaultAgent, 'eli-mode', '失效后立刻读到新值')
  } finally {
    delete process.env.WECHAT_ROUTER_SETTINGS
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
