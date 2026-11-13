// 零侵入生效点：包装宿主 `sessions.create`，并在空白会话上做一次补正。
//
// 为什么是这里：dsh-wechat-assistant 在 `src/bridge.ts` 里写死了
// `sessions.create({ ..., agentPreset: 'wechat' })`。我们不碰它的任何一行代码，
// 而是在 host 平面把宿主 `sessions` 服务的**这一个方法**包一层，按群名改写 `agentPreset`。
//
// 为什么从 apiProxy 迁移到 sessions / agentPresets：
//   DSH 0.2.2-rc.1 里 `apiProxy` 服务已不存在（整个宿主源码 0 次出现），
//   架构改成了 TypeRT 远程协议，会话能力拆成两个可直接注入的宿主服务：
//     - `sessions`（@deepseek-ai/dsh-api-session-controller）：create / list / resolveAgent
//     - `agentPresets`（@deepseek-ai/dsh-agent-preset-registry）：list / select
//   同时旧 RPC 信封（`{ rpcId, payload }` / `{ result: { ok, value } }`）已废弃：
//   新服务直接收请求对象、直接返回值。所以 `randomUUID` / `request()` 这类信封辅助一并删掉。
//
// 两个服务的新契约（实测源码确认）：
//   - `sessions.create(request)`：request 直接是 `{ sessionId, workspaceId, agentPreset }`，
//     且对**已存在**的 sessionId 幂等（复用同一会话），所以改写已存在会话的参数无副作用；
//   - `sessions.list()` → `{ items: [...] }`，条目带 `blank`（是否还没跑过 turn）、
//     `running`、`agentPreset`（当前实际用的），因此"该不该补正"可以精确判断；
//   - `agentPresets.select(agent, agentPreset)`：**签名变了**——第一个参数是 agent 对象
//     （不是 sessionId，也不是 `{ sessionId }`），第二个才是预设 id；
//     锁定错误码是 `agent-preset/locked`（旧的 `agent-preset-locked` 已改）。
//     所以补正前要先 `sessions.resolveAgent(sessionId)` 拿到 agent 对象。
//
// 兜底原则：这里任何异常都只记日志并放行原始调用——绝不因为路由坏掉而让微信消息发不出去。

/** 幂等标记：同一个 sessions 服务只包装一次。 */
const WRAPPED = Symbol.for('dsh-wechat-agent-router.wrapped')

/** 锁定错误码：已有历史的会话换预设会被 DSH 以此拒绝（按约定跳过，不动它）。 */
const LOCKED_CODE = 'agent-preset/locked'

/**
 * 兼容函数：新模型下宿主服务直接返回值，本无需"解包"。
 * 但 `lib/web-routes.js` 仍 import 了 `unwrap`，为免跨文件冲突这里保留导出并做最小兼容：
 *   - 若传入是旧 RPC 信封 `{ result: { ok, value } }`，沿用旧语义（ok !== true 抛错，否则取 value）；
 *   - 否则（新模型：response 直接就是值）原样返回入参。
 * 这样两种形状的调用方都能继续工作，新的调用方拿到的一律是值本身。
 * @param response - 宿主服务返回值，或旧 RPC 信封。
 * @returns 解包后的值。
 */
export function unwrap(response) {
  const result = response?.result
  // 只有真正长成旧信封的样子才走旧逻辑，其余一律当作"已经是值"直接返回。
  if (result === null || typeof result !== 'object' || !('ok' in result)) return response
  if (result.ok !== true) {
    throw new Error(result?.error?.message ?? 'rpc 调用失败')
  }
  return result.value
}

/**
 * 包装宿主 `sessions.create`：把路由算出的预设写进创建参数。
 *
 * 新 create 的参数形状是**直接一个 request 对象**（可能跟一个可选的 signal），
 * 不再是 `{ rpcId, payload }`。所以 `resolveRoute` 拿到的就是 request 本身
 * （它带 `sessionId`，足够反查群名），被改写的是 `request.agentPreset`。
 *
 * @param options - `{ sessions, resolveRoute, log, warn }`。
 *   `sessions` 是注入的宿主会话服务（由 index.js 用 `ctx.inject(['sessions'], ...)` 接线；
 *   若调用方仍传 `apiProxy`，会回退读 `apiProxy.sessions` 以减少接线改动）。
 *   resolveRoute(request) 返回 `{ group, agent }`：agent 为空串 / null 表示不干预。
 * @returns `{ installed, reason?, already?, restore }`。
 */
export function installSessionRouting({ sessions: sessionsArg, apiProxy, resolveRoute, log, warn }) {
  // 优先用注入的 sessions；兼容还传 apiProxy 的旧接线。
  const sessions = sessionsArg ?? apiProxy?.sessions
  if (sessions === null || sessions === undefined || typeof sessions.create !== 'function') {
    return { installed: false, reason: 'sessions 服务不可用', restore: () => {} }
  }
  if (sessions[WRAPPED] === true) return { installed: true, already: true, restore: () => {} }

  const original = sessions.create
  sessions.create = function routedCreate(request, signal) {
    try {
      const resolved = resolveRoute(request)
      // agent 为空串 / null = 不干预；已是目标预设也不再改写（避免无谓改写）。
      if (resolved !== null && resolved !== undefined && resolved.agent !== '' &&
          resolved.agent !== request?.agentPreset) {
        log?.(`群「${resolved.group}」按路由改用预设 ${resolved.agent}（原 ${request?.agentPreset ?? '部署默认'}）`)
        // 新模型：request 直接是参数对象，浅拷贝后只改 agentPreset，其余字段原样透传。
        return original.call(this, { ...request, agentPreset: resolved.agent }, signal)
      }
    } catch (error) {
      warn?.(`路由改写会话预设失败，已按原参数创建：${error instanceof Error ? error.message : String(error)}`)
    }
    // 降级：不干预，按原参数放行——绝不让消息因路由坏掉而发不出去。
    return original.call(this, request, signal)
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
 * 为什么需要：`sessions.create` 对**已存在**的会话是幂等的，改写参数无效；
 * 而 dsh-wechat-assistant 在 DSH 启动时会为所有监听群预先建好会话
 * （`syncConfiguredGroups`），也可能在我们包装生效之前就建好了。
 * 好在 `agentPresets.select` 对**空白会话**是允许的，所以这里补一刀即可。
 * 已有历史的会话会被 DSH 以 `agent-preset/locked` 拒绝——按约定跳过，不动它。
 *
 * 新签名两步走：先 `sessions.resolveAgent(sessionId)` 拿到 agent 对象，
 * 再 `agentPresets.select(agent, preset)`（select 的第一个参数不再是 sessionId）。
 *
 * @param options - `{ sessions, agentPresets, resolveRoute, log, warn }`。
 * @returns `{ ok, applied, skipped, failed, error? }`。
 */
export async function reconcileBlankSessions({ sessions: sessionsArg, apiProxy, agentPresets, resolveRoute, log, warn }) {
  // 优先用注入的服务；兼容还传 apiProxy 的旧接线。
  const sessionsApi = sessionsArg ?? apiProxy?.sessions
  const presetsApi = agentPresets ?? apiProxy?.agentPresets
  if (sessionsApi === null || sessionsApi === undefined || typeof sessionsApi.list !== 'function') {
    return { ok: false, error: 'sessions 服务不可用', applied: [], skipped: [], failed: [] }
  }
  if (presetsApi === null || presetsApi === undefined || typeof presetsApi.select !== 'function') {
    return { ok: false, error: 'agentPresets 服务不可用', applied: [], skipped: [], failed: [] }
  }

  const applied = []
  const skipped = []
  const failed = []
  let items = []
  try {
    // 新模型：list() 直接返回 `{ items }`；unwrap 在此只是兜底兼容（对值原样返回）。
    items = unwrap(await sessionsApi.list())?.items ?? []
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
    if (resolved === null || resolved === undefined || resolved.agent === '') continue
    if (item.agentPreset === resolved.agent) continue
    if (item.blank !== true) {
      skipped.push({ group: resolved.group, reason: '已有历史（DSH 不允许换预设）', preset: item.agentPreset ?? '' })
      continue
    }
    if (item.running === true) {
      skipped.push({ group: resolved.group, reason: '正在处理消息', preset: item.agentPreset ?? '' })
      continue
    }

    // 新签名：select 需要的是 agent 对象，先用 sessionId 解析出来。
    let agent = null
    try {
      if (typeof sessionsApi.resolveAgent !== 'function') {
        throw new Error('sessions.resolveAgent 不可用')
      }
      agent = await sessionsApi.resolveAgent(item.sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ group: resolved.group, agent: resolved.agent, error: message })
      warn?.(`解析会话 agent 失败：群「${resolved.group}」：${message}`)
      continue
    }

    let ok = false
    let message = ''
    let code = ''
    try {
      const value = await presetsApi.select(agent, resolved.agent)
      // 新模型直接返回值；对旧信封形状也兜底识别 ok。
      ok = value?.result ? value.result.ok === true : value !== null && value !== undefined
      if (!ok) message = value?.result?.error?.message ?? '未知错误'
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
      // TypeRT RemoteError 把业务码放在 code 字段（如 agent-preset/locked），单独取出来。
      code = typeof error?.code === 'string' ? error.code : ''
    }

    if (ok) {
      applied.push({ group: resolved.group, agent: resolved.agent, previous: item.agentPreset ?? '' })
      log?.(`空白会话已补正：群「${resolved.group}」→ 预设 ${resolved.agent}`)
    } else {
      // 锁定错误码可能在 code（TypeRT RemoteError）或 message 里，两处都认。
      const locked = code === LOCKED_CODE || message === LOCKED_CODE || message.includes(LOCKED_CODE)
      if (locked) {
        // 锁定的空白会话按约定跳过：DSH 不允许换预设，不动它。
        skipped.push({ group: resolved.group, reason: '会话已开始（DSH 不允许换预设）', preset: item.agentPreset ?? '' })
        continue
      }
      failed.push({ group: resolved.group, agent: resolved.agent, error: message, locked })
      warn?.(`补正会话失败：群「${resolved.group}」→ ${resolved.agent}：${message}`)
    }
  }

  return { ok: true, applied, skipped, failed }
}
