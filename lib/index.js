// dsh-wechat-agent-router host 入口。
//
// 职责：① 注册自己的设置命名空间（路由规则）；② 在 host 平面包装
// `apiProxy.sessions.create`，把"这个群的会话用哪个预设"改成按群名路由的结果；
// ③ 挂 loopback 路由给浏览器半读写配置、查看现状、手动补正。
//
// 设计底线（见 README）：
//   - 不复制、不修改 dsh-wechat-assistant 的任何逻辑（监听/收发/归档全部复用）；
//   - 只干预"会话用哪个 Agent 预设"这一个值；
//   - 任何异常都降级成"不干预"，绝不让微信消息因为路由坏掉而发不出去。
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createGroupResolver, routeFor } from './router.js'
import { NAMESPACE, RouterSchema } from './schema.js'
import { createConfigSnapshot } from './settings-file.js'
import { applyWebRoutes } from './web-routes.js'
import { installSessionRouting, reconcileBlankSessions } from './wrap.js'

export const name = 'dsh-wechat-agent-router'

/** 设置命名空间（品牌化字符串，供 settings 服务识别）。 */
export const ROUTER_NS = settingsNamespace(NAMESPACE)

/** 首次补正的延迟：等 dsh-wechat-assistant 的 syncConfiguredGroups 把会话建完。 */
const FIRST_RECONCILE_DELAY_MS = 3000

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
  const reconcile = () => reconcileBlankSessions({
    apiProxy: ctx.get('apiProxy'),
    resolveRoute,
    log,
    warn,
  })

  ctx.inject(['settings'], (settingsCtx) => {
    // applies:'live'：改配置不需要重启；包装层每次都重读（TTL 快照），所以立刻生效。
    settingsCtx.settings.register(ROUTER_NS, RouterSchema, { applies: 'live' })
  })

  ctx.inject(['apiProxy'], (proxyCtx) => {
    const installed = installSessionRouting({ apiProxy: proxyCtx.apiProxy, resolveRoute, log, warn })
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

  ctx.inject(['webServer'], (serverCtx) => applyWebRoutes(serverCtx, {
    snapshot,
    resolveRoute,
    /** 只按 sessionId 反查群名（不看路由），供面板把"这个群当前用什么预设"显示出来。 */
    groupOf: (sessionId) => groupOf(sessionId, snapshot.get().groups),
    reconcile,
    isWrapped: () => wrapped,
  }))

  ctx.logger?.info?.('dsh-wechat-agent-router 已加载')
}
