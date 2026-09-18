// 零侵入生效点：包装 `ctx.apiProxy.sessions.create`，并在空白会话上做一次补正。
//
// 为什么是这里：dsh-wechat-assistant 在 `src/bridge.ts` 里写死了
// `sessions.create({ ..., agentPreset: 'wechat' })`。我们不碰它的任何一行代码，
// 而是在 host 平面把 `apiProxy` 的**这一个方法**包一层，按群名改写 `agentPreset`。
// 依据（实测 dsh-host-apiproxy/lib/index.js）：
//   - 域是实例属性上的**普通对象**（`this.sessions = api.sessions`），方法可安全替换；
//   - `sessions.create` 的契约写明"同一 sessionId 重试返回同一个会话"（幂等），
//     所以对已存在的会话改写参数不会产生副作用（也正好对应"已有会话不用管"）；
//   - `sessions.list()` 的条目带 `blank`（是否还没跑过 turn）与 `agentPreset`（当前实际用的），
//     所以"该不该补正"可以精确判断，而不是靠猜。
//
// 兜底原则：这里任何异常都只记日志并放行原始调用——绝不因为路由坏掉而让微信消息发不出去。
import { randomUUID } from 'node:crypto'

/** 幂等标记：同一个 apiProxy 只包装一次。 */
const WRAPPED = Symbol.for('dsh-wechat-agent-router.wrapped')

const rpcId = () => randomUUID()
const request = (payload) => ({ rpcId: rpcId(), payload })

/** 取出 RPC 响应的 value；`ok !== true` 时抛错（与 bridge.ts 的 unwrap 同语义）。 */
export function unwrap(response) {
  if (response === null || response === undefined || response?.result?.ok !== true) {
    const message = response?.result?.error?.message ?? 'rpc 调用失败'
    throw new Error(message)
  }
  return response.result.value
}

/**
 * 包装 `apiProxy.sessions.create`：把路由算出的预设写进创建参数。
 * @param options - `{ apiProxy, resolveRoute, log, warn }`。
 *   resolveRoute(payload) 返回 `{ group, agent }`：agent 为空串表示不干预。
 * @returns `{ installed, reason?, already?, restore }`。
 */
export function installSessionRouting({ apiProxy, resolveRoute, log, warn }) {
  const sessions = apiProxy?.sessions
  if (sessions === null || sessions === undefined || typeof sessions.create !== 'function') {
    return { installed: false, reason: 'apiProxy.sessions 不可用', restore: () => {} }
  }
  if (sessions[WRAPPED] === true) return { installed: true, already: true, restore: () => {} }

  const original = sessions.create
  sessions.create = function routedCreate(request_, signal) {
    try {
      const resolved = resolveRoute(request_?.payload)
      if (resolved !== null && resolved.agent !== '' && resolved.agent !== request_?.payload?.agentPreset) {
        log?.(`群「${resolved.group}」按路由改用预设 ${resolved.agent}（原 ${request_?.payload?.agentPreset ?? '部署默认'}）`)
        return original.call(this, { ...request_, payload: { ...request_?.payload, agentPreset: resolved.agent } }, signal)
      }
    } catch (error) {
      warn?.(`路由改写会话预设失败，已按原参数创建：${error instanceof Error ? error.message : String(error)}`)
    }
    return original.call(this, request_, signal)
  }
  sessions[WRAPPED] = true

  return {
    installed: true,
    restore() {
      if (sessions[WRAPPED] !== true) return
      sessions.create = original
      delete sessions[WRAPPED]
    },
  }
}

/**
 * 补正：把"已经存在、还没聊过、预设不对"的群会话切到路由目标。
 *
 * 为什么需要：`sessions.create` 是幂等的，对**已存在**的会话改写参数无效；
 * 而 dsh-wechat-assistant 在 DSH 启动时会为所有监听群预先建好会话
 * （`syncConfiguredGroups`），也可能在我们包装生效之前就建好了。
 * 好在 `agentPreset.select` 对**空白会话**是允许的，所以这里补一刀即可。
 * 已有历史的会话会被 DSH 以 `agent-preset-locked` 拒绝——按约定跳过，不动它。
 *
 * @param options - `{ apiProxy, resolveRoute, log, warn }`。
 * @returns `{ ok, applied, skipped, failed, error? }`。
 */
export async function reconcileBlankSessions({ apiProxy, resolveRoute, log, warn }) {
  const sessionsApi = apiProxy?.sessions
  const presetsApi = apiProxy?.agentPresets
  if (sessionsApi === null || sessionsApi === undefined || typeof sessionsApi.list !== 'function') {
    return { ok: false, error: 'apiProxy.sessions 不可用', applied: [], skipped: [], failed: [] }
  }
  if (presetsApi === null || presetsApi === undefined || typeof presetsApi.select !== 'function') {
    return { ok: false, error: 'apiProxy.agentPresets 不可用', applied: [], skipped: [], failed: [] }
  }

  const applied = []
  const skipped = []
  const failed = []
  let items = []
  try {
    items = unwrap(await sessionsApi.list(request({})))?.items ?? []
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), applied, skipped, failed }
  }

  for (const item of items) {
    let resolved = null
    try {
      resolved = resolveRoute({ sessionId: item?.sessionId })
    } catch {
      resolved = null
    }
    if (resolved === null || resolved.agent === '') continue
    if (item.agentPreset === resolved.agent) continue
    if (item.blank !== true) {
      skipped.push({ group: resolved.group, reason: '已有历史（DSH 不允许换预设）', preset: item.agentPreset ?? '' })
      continue
    }
    if (item.running === true) {
      skipped.push({ group: resolved.group, reason: '正在处理消息', preset: item.agentPreset ?? '' })
      continue
    }
    const response = await presetsApi.select(request({ sessionId: item.sessionId, agentPreset: resolved.agent }))
    if (response?.result?.ok === true) {
      applied.push({ group: resolved.group, agent: resolved.agent, previous: item.agentPreset ?? '' })
      log?.(`空白会话已补正：群「${resolved.group}」→ 预设 ${resolved.agent}`)
    } else {
      const message = response?.result?.error?.message ?? '未知错误'
      failed.push({ group: resolved.group, agent: resolved.agent, error: message })
      warn?.(`补正会话失败：群「${resolved.group}」→ ${resolved.agent}：${message}`)
    }
  }

  return { ok: true, applied, skipped, failed }
}
