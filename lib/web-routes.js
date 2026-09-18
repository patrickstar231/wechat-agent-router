// loopback HTTP 路由（host 平面）——浏览器半的唯一后端。
//
// 覆盖三类请求：
//   1. bootstrap：路由规则 + 监听群现状（每个群当前实际用哪个预设、对不对得上）+ 可选的 Agent 预设名单；
//   2. reconcile：立即补正（把"还没聊过但预设不对"的群会话切到路由目标）；
//   3. settings/describe + settings/mutate：设置桥。官方设置页只放行白名单命名空间，
//      这条 loopback-only 的桥让配置页在任意 DSH 上开箱即用（与 agent-manager 同款做法）。
import { randomUUID } from 'node:crypto'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { describeRoutes, SESSION_PREFIX } from './router.js'
import { NAMESPACE } from './schema.js'
import { settingsPath } from './settings-file.js'
import { unwrap } from './wrap.js'

export const name = 'wechat-agent-router-web'
export const inject = ['webServer']

const NS = settingsNamespace(NAMESPACE)
const MAX_JSON_BYTES = 128 * 1024

// 与仓库根 src/index.ts 的 guard 同策略：仅 loopback + 同源、限制请求体、错误脱敏。
// 跨包无法复用那两个私有函数，这里复制一份最小实现，换取插件自包含。
function trustedRequest(req) {
  const remote = req.socket?.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false
  const origin = req.headers.origin
  return !origin || origin === `http://${req.headers.host}`
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length > 0 ? JSON.parse(text) : {}
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[A-Za-z0-9_-]{24,}/g, '[已脱敏]').slice(0, 1200)
}

/** 设置桥的视图：与官方 settingsScope 的 describe 形状对齐。 */
function viewOf(settings) {
  if (settings === undefined || settings === null) return { ok: false, error: 'settings 服务不可用' }
  const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === String(NS))
  if (descriptor === undefined) return { ok: false, error: `命名空间未注册：${NAMESPACE}` }
  return {
    ok: true,
    value: {
      ns: String(descriptor.ns),
      ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
      ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
      value: descriptor.value,
      writable: descriptor.writable,
      revision: descriptor.revision,
    },
  }
}

/**
 * 挂载全部路由。由 host 入口在 webServer 就绪后调用。
 * @param ctx - 已注入 webServer 的上下文。
 * @param deps - `{ snapshot, resolveRoute, groupOf, reconcile, isWrapped }`（由 host 入口提供）。
 */
export function applyWebRoutes(ctx, deps) {
  const server = ctx.webServer
  const apiProxy = () => ctx.get('apiProxy')
  const request = (payload) => ({ rpcId: randomUUID(), payload })

  const route = (path, handler) => server.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
      try {
        const body = req.method === 'POST' ? await readJson(req) : {}
        const payload = await handler(body)
        writeJson(res, 200, payload !== null && typeof payload === 'object' ? { ok: true, ...payload } : { ok: true, value: payload })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  })

  ctx.effect(() => route('/wechat-agent-router/api/bootstrap', async () => {
    const { config, groups } = deps.snapshot.get()
    const preview = describeRoutes(config, groups)
    const wanted = new Map(preview.map((row) => [row.group, row.agent]))

    let sessions = []
    let sessionsError = ''
    try {
      const items = unwrap(await apiProxy()?.sessions?.list(request({})))?.items ?? []
      sessions = items
        .filter((item) => typeof item?.sessionId === 'string' && item.sessionId.startsWith(SESSION_PREFIX))
        .map((item) => {
          let group = null
          try {
            group = deps.groupOf(item.sessionId)
          } catch {
            group = null
          }
          const target = group === null ? '' : (wanted.get(group) ?? '')
          return {
            sessionId: item.sessionId,
            group,
            preset: item.agentPreset ?? '',
            blank: item.blank === true,
            running: item.running === true,
            wanted: target,
            // aligned=true 表示这个群当前跑的就是路由要求的预设（或路由不干预）
            aligned: target === '' || item.agentPreset === target,
          }
        })
        .sort((left, right) => String(left.group ?? left.sessionId).localeCompare(String(right.group ?? right.sessionId), 'zh'))
    } catch (error) {
      sessionsError = safeError(error)
    }

    let presets = []
    let presetsError = ''
    try {
      const value = unwrap(await apiProxy()?.agentPresets?.list(request({})))
      presets = (value?.presets ?? []).map((preset) => ({
        id: preset.id,
        name: preset.name ?? '',
        description: preset.description ?? '',
        trust: preset.trust,
        isDefault: preset.isDefault === true,
        broken: preset.broken ?? '',
      }))
    } catch (error) {
      presetsError = safeError(error)
    }

    return {
      ok: true,
      enabled: config.enabled,
      defaultAgent: config.defaultAgent,
      rules: config.rules,
      groups,
      preview,
      sessions,
      sessionsError,
      presets,
      presetsError,
      wrapped: deps.isWrapped(),
      settingsPath: settingsPath(),
    }
  }), 'wechat-agent-router.route-bootstrap()')

  ctx.effect(() => route('/wechat-agent-router/api/reconcile', () => deps.reconcile()), 'wechat-agent-router.route-reconcile()')

  ctx.effect(() => route('/wechat-agent-router/api/settings/describe', () => viewOf(ctx.get('settings'))), 'wechat-agent-router.route-settings-describe()')

  ctx.effect(() => route('/wechat-agent-router/api/settings/mutate', async (body) => {
    const settings = ctx.get('settings')
    if (settings === undefined || settings === null) return { ok: false, error: 'settings 服务不可用' }
    try {
      await settings.mutate(NS, Array.isArray(body?.ops) ? body.ops : [], body?.expectedRevision)
    } catch (error) {
      if (error instanceof SettingsConflictError) {
        return { ok: false, code: 'settings-conflict', message: error.message, details: { expected: error.expected, actual: error.actual } }
      }
      return { ok: false, code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) }
    }
    // 配置刚改过：立刻让快照失效，并补正一次（把还没聊过的群会话切到新目标）。
    deps.snapshot.invalidate()
    const reconciled = await deps.reconcile()
    return { ...viewOf(settings), reconciled }
  }), 'wechat-agent-router.route-settings-mutate()')
}
