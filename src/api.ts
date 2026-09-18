// 浏览器半的数据通道。
//
// 读写都只走 host 侧那条 loopback 设置桥（/wechat-agent-router/api/*），不走官方
// settingsScope：官方设置页只放行白名单命名空间，未放行时 scope 会一直 loading
// （agent-manager / eli-mode 都为此自建了同一座桥）。
const API = '/wechat-agent-router/api'

export type RuleMode = 'contains' | 'exact'
export type RouteRule = { match: string; mode: RuleMode; agent: string }
export type PresetOption = {
  id: string
  name: string
  description: string
  trust: string
  isDefault: boolean
  broken: string
}
export type PreviewRow = { group: string; agent: string; matched: RouteRule | null }
export type SessionRow = {
  sessionId: string
  group: string | null
  preset: string
  blank: boolean
  running: boolean
  wanted: string
  aligned: boolean
}
export type ReconcileResult = {
  ok: boolean
  error?: string
  applied: { group: string; agent: string; previous: string }[]
  skipped: { group: string; reason: string; preset: string }[]
  failed: { group: string; agent: string; error: string }[]
}
export type Bootstrap = {
  enabled: boolean
  defaultAgent: string
  rules: RouteRule[]
  groups: string[]
  preview: PreviewRow[]
  sessions: SessionRow[]
  sessionsError: string
  presets: PresetOption[]
  presetsError: string
  wrapped: boolean
  settingsPath: string
}
export type SettingsView = {
  value: { enabled?: boolean; defaultAgent?: string; rules?: RouteRule[] } | undefined
  user: Record<string, unknown> | undefined
  writable: boolean
  revision: number | undefined
}

async function post(path: string, body: unknown): Promise<any> {
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
  return payload
}

/** 读规则、监听群现状与可选预设名单。 */
export async function bootstrap(): Promise<Bootstrap> {
  const payload = await post('/bootstrap', {})
  if (!payload.ok) throw new Error(payload.error ?? 'bootstrap failed')
  return payload as Bootstrap
}

/** 立即补正：把"还没聊过但预设不对"的群会话切到路由目标。 */
export async function reconcile(): Promise<ReconcileResult> {
  const payload = await post('/reconcile', {})
  if (!payload.ok) throw new Error(payload.error ?? 'reconcile failed')
  return payload as ReconcileResult
}

/** 读设置（含 revision，写入时用于冲突检测）。 */
export async function readSettings(): Promise<SettingsView> {
  const payload = await post('/settings/describe', {})
  if (!payload.ok) throw new Error(payload.error ?? 'settings unavailable')
  return payload.value as SettingsView
}

/**
 * 逐个字段写（不整段覆盖），这样 settings.yaml 里别人加的未知字段不会被抹掉。
 * 遇到 revision 冲突自动用最新 revision 重试一次：面板开着时手改 yaml 也能保存成功。
 */
export async function saveConfig(
  config: { enabled: boolean; defaultAgent: string; rules: RouteRule[] },
  expectedRevision: number | undefined,
): Promise<SettingsView & { reconciled?: ReconcileResult }> {
  const ops = [
    { op: 'set', path: ['enabled'], value: config.enabled },
    { op: 'set', path: ['defaultAgent'], value: config.defaultAgent },
    { op: 'set', path: ['rules'], value: config.rules },
  ]
  const attempt = async (revision: number | undefined) => post('/settings/mutate', {
    ops,
    ...(revision === undefined ? {} : { expectedRevision: revision }),
  })
  let payload = await attempt(expectedRevision)
  if (!payload.ok && payload.code === 'settings-conflict') {
    const fresh = await readSettings()
    payload = await attempt(fresh.revision)
  }
  if (!payload.ok) throw new Error(payload.message ?? payload.error ?? 'save failed')
  return payload.value as SettingsView & { reconciled?: ReconcileResult }
}
