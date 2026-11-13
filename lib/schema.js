// 配置形状与默认值。
// 三处共用（host 入口导出的 Config、浏览器半绑定的设置桥、包装层读的配置快照），
// 所以形状只在这里定义一次，避免漂移。
//
// 0.2.2-rc.1 新模型：不再把 schema 显式注册进设置服务，而是把它作为 cordis
// 插件的 `Config` 导出（见 lib/index.js 的 `export const Config`）。设置服务只把标记了
// `.volatile()` 的字段投影成"改了即时生效"的设置项，所以顶层三个字段都要标。
import z from '@deepseek-ai/schemastery'
import { RULE_MODES } from './router.js'

/** 设置命名空间（= cordis profile 条目 id，见 cordis.patch.yml 的 `id`）。 */
export const NAMESPACE = 'wechat-agent-router'

/** 同事的微信助手命名空间（本插件只读它的 groups，绝不写）。 */
export const WECHAT_NAMESPACE = 'wechat-assistant'

// 宿主 fork 的 schemastery 才有 `.volatile()`；老版本没有该方法。这里做防御：
// 有就标（设置服务才会把它当"即时生效"字段投影），没有就原样返回，
// 保证本 schema 在任意 schemastery 上都能构建（测试 / CI 不依赖宿主 fork）。
function live(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}

const RouteRuleSchema = z.object({
  /** 匹配串：群名的关键字（contains）或整名（exact）。 */
  match: z.string().default(''),
  /** contains | exact。 */
  mode: z.string().default('contains'),
  /** 命中后要使用的 Agent 预设 id。 */
  agent: z.string().default(''),
})

export const RouterSchema = z.object({
  /** 总开关。关闭 = 完全不干预，保持 dsh-wechat-assistant 原本的行为。 */
  enabled: live(z.boolean().default(true)),
  /** 兜底预设：所有规则都没命中时用它。空串 = 不干预。 */
  defaultAgent: live(z.string().default('')),
  rules: live(z.array(RouteRuleSchema).default([])),
})

/** 未配置时的有效值。 */
export function defaultRouterConfig() {
  return { enabled: true, defaultAgent: '', rules: [] }
}

/**
 * 把「存进配置的稀疏值」补齐成可直接使用的完整配置。
 * 缺字段取默认，容忍损坏值（配置可能人手编辑）。
 * @param raw - 该命名空间的原始对象，可能为空或缺字段。
 * @returns 完整配置。
 */
export function normalizeRouterConfig(raw) {
  const base = defaultRouterConfig()
  if (raw === null || typeof raw !== 'object') return base
  const rules = Array.isArray(raw.rules)
    ? raw.rules
      .filter((rule) => rule !== null && typeof rule === 'object')
      .map((rule) => ({
        match: typeof rule.match === 'string' ? rule.match : '',
        mode: RULE_MODES.includes(rule.mode) ? rule.mode : 'contains',
        agent: typeof rule.agent === 'string' ? rule.agent : '',
      }))
    : base.rules
  return {
    enabled: raw.enabled !== false,
    defaultAgent: typeof raw.defaultAgent === 'string' ? raw.defaultAgent : '',
    rules,
  }
}
