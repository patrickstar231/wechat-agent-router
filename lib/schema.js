// 配置形状与默认值。
// 三处共用（host 注册命名空间、浏览器半绑定同一命名空间、包装层直接读 settings.yaml），
// 所以形状只在这里定义一次，避免漂移。
import z from '@deepseek-ai/schemastery'
import { RULE_MODES } from './router.js'

/** 设置命名空间（~/.dsh/settings.yaml 下的段名）。 */
export const NAMESPACE = 'wechat-agent-router'

/** 同事的微信助手命名空间（本插件只读它的 groups，绝不写）。 */
export const WECHAT_NAMESPACE = 'wechat-assistant'

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
  enabled: z.boolean().default(true),
  /** 兜底预设：所有规则都没命中时用它。空串 = 不干预。 */
  defaultAgent: z.string().default(''),
  rules: z.array(RouteRuleSchema).default([]),
})

/** 未配置时的有效值。 */
export function defaultRouterConfig() {
  return { enabled: true, defaultAgent: '', rules: [] }
}

/**
 * 把「存进 settings.yaml 的稀疏配置」补齐成可直接使用的完整配置。
 * 缺字段取默认，容忍损坏值（settings.yaml 是人手可编辑的）。
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
