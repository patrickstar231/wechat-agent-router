// loopback HTTP 路由（host 平面）——浏览器半的唯一后端。
//
// 覆盖三类请求：
//   1. bootstrap：路由规则 + 监听群现状（每个群当前实际用哪个预设、对不对得上）+ 可选的 Agent 预设名单；
//   2. reconcile：立即补正（把"还没聊过但预设不对"的群会话切到路由目标）；
//   3. settings/describe + settings/mutate：设置桥。官方设置页只放行白名单命名空间，
//      这条 loopback-only 的桥让配置页在任意 DSH 上开箱即用（与 agent-manager 同款做法）。
//
// 与 DSH 0.2.2-rc.1 的对齐：
//   - **不再有命名空间包装函数**：设置命名空间就是本插件条目 id（NAMESPACE 字符串）。
//   - **不再有 `apiProxy`**：会话与预设能力改用宿主服务 `sessions` / `agentPresets`，
//     由 host 入口注入后传入，直接调用（不再用 `{rpcId,payload}` 信封 / `unwrap`）。
//   - `settings.describe()` 的描述符**没有 `writable` 字段**，`ns` 即条目 id；`mutate` 签名不变。
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { describeRoutes, SESSION_PREFIX } from './router.js'
import { NAMESPACE } from './schema.js'
import { settingsPath } from './settings-file.js'

export const name = 'wechat-agent-router-web'
export const inject = ['webServer']

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

/** 设置桥的视图：与官方 settingsScope 的 describe 形状对齐。
 *  0.2.2-rc.1 的描述符不再携带 `writable` 字段（ns 即条目 id）。这里显式回填
 *  `writable: true`（profile 设置本就可写），让客户端无需改动即可继续用它控制只读态。 */
function viewOf(settings) {
  if (settings === undefined || settings === null) return { ok: false, error: 'settings 服务不可用' }
  const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === String(NAMESPACE))
  if (descriptor === undefined) return { ok: false, error: `命名空间未注册：${NAMESPACE}` }
  return {
    ok: true,
    value: {
      ns: String(descriptor.ns),
      ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
      ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
      value: descriptor.value,
      revision: descriptor.revision,
      writable: true,
    },
  }
}

/**
 * 挂载全部路由。由 host 入口在 webServer 就绪后调用。
 * @param ctx - 已注入 webServer 的上下文（宿主 `sessions` / `agentPresets` 服务可用 ctx.get 取）。
 * @param deps - `{ snapshot, resolveRoute, groupOf, reconcile, isWrapped }`（由 host 入口提供）。
 */
export function applyWebRoutes(ctx, deps) {
  const server = ctx.webServer
  // 0.2.2-rc.1：宿主服务直接返回值，不再用 {rpcId,payload} 信封 / unwrap。
  const sessionsApi = () => ctx.get('sessions')
  const presetsApi = () => ctx.get('agentPresets')

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
      // 0.2.2-rc.1：sessions.list() 直接返回 { items }。
      const items = (await sessionsApi()?.list())?.items ?? []
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
      // 0.2.2-rc.1：agentPresets.remoteExportList() 直接返回 { presets }，每个带 isDefault。
      const api = presetsApi()
      const value = typeof api?.remoteExportList === 'function'
        ? await api.remoteExportList()
        : { presets: (await api?.list())?.presets ?? [] }
      presets = (value?.presets ?? []).map((preset) => ({
        id: preset.id,
        name: preset.name ?? '',
        description: preset.description ?? '',
        // 0.2.2-rc.1 的 preset 描述符不再携带 trust 字段。
        trust: preset.trust ?? '',
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
      await settings.mutate(NAMESPACE, Array.isArray(body?.ops) ? body.ops : [], body?.expectedRevision)
    } catch (error) {
      if (error instanceof SettingsConflictError) {
        return { ok: false, code: 'settings-conflict', message: error.message, details: { expected: error.expected, actual: error.actual } }
      }
      return { ok: false, code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) }
    }
    // 配置刚改过：立刻刷新快照（异步重取注入值）并补正一次（把还没聊过的群会话切到新目标）。
    // await refresh 而非只 invalidate：保证下面这次 reconcile 读到的就是刚保存的配置。
    if (typeof deps.snapshot?.refresh === 'function') await deps.snapshot.refresh()
    else deps.snapshot.invalidate()
    const reconciled = await deps.reconcile()
    return { ...viewOf(settings), reconciled }
  }), 'wechat-agent-router.route-settings-mutate()')
}
