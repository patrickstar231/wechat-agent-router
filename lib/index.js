// dsh-wechat-agent-router host 入口。
//
// 职责：① 导出路由配置的 Config schema（设置服务据此投影"改了即时生效"的设置项）；
// ② 在 host 平面包装宿主 `sessions.create`，把"这个群的会话用哪个预设"改成按群名路由；
// ③ 挂 loopback 路由给浏览器半读写配置、查看现状、手动补正。
//
// 0.2.2-rc.1 的两点架构变化（实测宿主源码确认）：
//   - 设置服务是 SettingsForms 类（只有 describe/update/...，**没有 register**），也没有
//     命名空间包装函数。配置改为来自本插件的 `Config` schema（下方 export const Config），
//     命名空间就是 profile 条目 id（NAMESPACE = 'wechat-agent-router'）。
//   - `apiProxy` 服务已不存在；会话/预设能力拆成两个可直接注入的宿主服务：
//     `sessions`（create/list/resolveAgent）与 `agentPresets`（list/select）。
//
// 设计底线（见 README）：
//   - 不复制、不修改 dsh-wechat-assistant 的任何逻辑（监听/收发/归档全部复用）；
//   - 只干预"会话用哪个 Agent 预设"这一个值；
//   - 任何异常都降级成"不干预"，绝不让微信消息因为路由坏掉而发不出去。
import { createGroupResolver, routeFor } from './router.js'
import { NAMESPACE, RouterSchema, WECHAT_NAMESPACE } from './schema.js'
import { createConfigSnapshot } from './settings-file.js'
import { applyWebRoutes } from './web-routes.js'
import { installSessionRouting, reconcileBlankSessions } from './wrap.js'

export const name = 'dsh-wechat-agent-router'

/**
 * 插件配置 schema（cordis 约定）。设置服务会把它当本插件的配置，
 * 并只把标记了 `.volatile()` 的字段（enabled/defaultAgent/rules，见 schema.js）投影成
 * 改了即时生效的设置项。命名空间 = profile 条目 id = NAMESPACE。
 */
export const Config = RouterSchema

/** 首次补正的延迟：等 dsh-wechat-assistant 的 syncConfiguredGroups 把会话建完。 */
const FIRST_RECONCILE_DELAY_MS = 3000

/** 轮询设置服务的间隔：官方设置页改配置不经过本插件的 mutate 路由，靠轮询追平。 */
const SETTINGS_REFRESH_INTERVAL_MS = 4000

/**
 * 从设置服务的 describe 结果里取本插件关心的当前值。
 * 本插件配置在 NAMESPACE 条目下；同事的监听群名在 WECHAT_NAMESPACE 条目下（只读）。
 * 任何缺失都返回 undefined，由 settings-file.js 的 normalize 兜默认。
 * @param settings - 注入的设置服务（SettingsForms）。
 * @returns `{ config, groups }`（原始值，未 normalize）。
 */
function readCurrentFromSettings(settings) {
  const described = typeof settings?.describe === 'function' ? settings.describe() : []
  const list = Array.isArray(described) ? described : []
  const find = (ns) => list.find((candidate) => String(candidate?.ns) === ns)
  return {
    config: find(NAMESPACE)?.value,
    groups: find(WECHAT_NAMESPACE)?.value?.groups,
  }
}

/** @param ctx - host 上下文。 */
export function apply(ctx) {
  const snapshot = createConfigSnapshot()
  let wrapped = false
  let resolverCache = { groups: null, resolve: () => null }

  /** 用「监听群名」列表把 sessionId 反查成群名（列表变化时重建索引）。 */
  const groupOf = (sessionId, groups) => {
    if (resolverCache.groups !== groups) resolverCache = { groups, resolve: createGroupResolver(groups) }
    return resolverCache.resolve(sessionId)
  }

  /**
   * 核心决策：这次会话该用哪个预设。
   * 返回 null = 不干预（沿用 dsh-wechat-assistant 原本点名的预设）。
   * 同步读快照（绝不 await）——包装层在 sessions.create 路径上调用。
   */
  const resolveRoute = (payload) => {
    const { config, groups } = snapshot.get()
    if (config.enabled === false) return null
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return null
    const group = groupOf(sessionId, groups)
    if (group === null) return null
    const agent = routeFor(config, group)
    return agent === '' ? null : { group, agent }
  }

  const log = (message) => ctx.logger?.info?.(`wechat-agent-router: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`wechat-agent-router: ${message}`)

  // 设置服务可用后，把"当前生效配置"异步喂给同步快照。启动刷一次 + 定期轮询，
  // 这样无论配置从我们的设置桥还是官方设置页改，都能追平；wrap.js 的决策路径保持同步。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    snapshot.setLoader(() => readCurrentFromSettings(settings))
    void snapshot.refresh().then((loaded) => {
      // 静默失效防护：配了路由但拿不到任何监听群名，路由会"从不干预"且不报错。
      // 0.2.2-rc.1 起 groups 只能从设置服务 describe() 的 volatile 投影里读——若同事的
      // dsh-wechat-assistant 没把 groups 标 volatile，这里就是空的。明确告警而不是装作正常。
      const { config, groups } = snapshot.get()
      const hasRoute = config.enabled !== false && (config.rules.length > 0 || config.defaultAgent !== '')
      if (hasRoute && groups.length === 0) {
        warn('已配置路由规则，但读不到任何监听群名（wechat-assistant.groups）。' +
          '0.2.2-rc.1 起该值须经设置服务的 volatile 字段投影；若上游未标 volatile，路由不会生效。')
      }
      return loaded
    }).catch((error) => warn(`载入路由配置失败：${error instanceof Error ? error.message : String(error)}`))
    const timer = setInterval(() => { void snapshot.refresh() }, SETTINGS_REFRESH_INTERVAL_MS)
    ctx.effect(() => () => clearInterval(timer), 'wechat-agent-router.settings-refresh()')
  })

  // 补正：懒取当前注入的 sessions / agentPresets 单例（与包装共享同一批实例；
  // 只有 create 被包过，list / resolveAgent 不受影响）。
  const reconcile = () => reconcileBlankSessions({
    sessions: ctx.get('sessions'),
    agentPresets: ctx.get('agentPresets'),
    resolveRoute,
    log,
    warn,
  })

  // 会话 + 预设服务可用后：包装 sessions.create，并安排一次启动补正。
  ctx.inject(['sessions', 'agentPresets'], (servicesCtx) => {
    const installed = installSessionRouting({ sessions: servicesCtx.sessions, resolveRoute, log, warn })
    wrapped = installed.installed
    if (installed.installed) log('已接管 sessions.create 的 agentPreset 决定权（按群名路由）')
    else warn(`会话预设包装未安装：${installed.reason}`)
    ctx.effect(() => () => installed.restore(), 'wechat-agent-router.wrap()')

    // 启动后补正一次：覆盖"会话已存在且还没聊过，但预设在包装生效前就定下了"的情况。
    const timer = setTimeout(() => {
      void reconcile()
        .then((result) => {
          if (result.ok !== true) return
          if (result.applied.length > 0) log(`启动补正完成：${result.applied.length} 个空白会话已切到路由预设`)
        })
        .catch((error) => warn(`启动补正失败：${error instanceof Error ? error.message : String(error)}`))
    }, FIRST_RECONCILE_DELAY_MS)
    ctx.effect(() => () => clearTimeout(timer), 'wechat-agent-router.first-reconcile()')
  })

  // webServer 就绪后挂 loopback 路由。独立于会话/预设服务注入：即便某服务缺失，面板仍能
  // 挂载并在请求时用 ctx.get 懒取（缺了就报错降级），不会连设置桥一起带崩。
  ctx.inject(['webServer'], (serverCtx) => applyWebRoutes(serverCtx, {
    snapshot,
    reconcile,
    /** 只按 sessionId 反查群名（不看路由），供面板把"这个群当前用什么预设"显示出来。 */
    groupOf: (sessionId) => groupOf(sessionId, snapshot.get().groups),
    isWrapped: () => wrapped,
  }))

  ctx.logger?.info?.('dsh-wechat-agent-router 已加载')
}
