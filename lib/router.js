// 路由纯函数：群名 → Agent 预设 id。零依赖（除 node:crypto）、可脱离 DSH 单测。
//
// 为什么能只看群名就路由：dsh-wechat-assistant 给每个群一条**确定性**会话
// （sessionId = 'wechat-group-' + sha256(群名).slice(0,32)），且每次群消息前都会
// 用同一个 id 调 sessions.create。于是"这个会话属于哪个群"可以从 id 反查到
// （见 createGroupResolver），也可以从会话标题 `微信群 <群名>` 反解（兜底）。
import { createHash } from 'node:crypto'

/** 群会话 id 前缀——与 dsh-wechat-assistant 的 bridge.ts 保持一致。 */
export const SESSION_PREFIX = 'wechat-group-'

/** 支持的匹配方式。 */
export const RULE_MODES = ['contains', 'exact']

/**
 * 复刻 dsh-wechat-assistant 的 sessionId 方案。
 * 刻意依赖它：这个 id 是会话的**持久身份**（改了会让所有历史会话变成孤儿），
 * 因此比"消息文本/标题格式"稳定得多；标题解析只作为兜底通道。
 * @param group - 群名（内部 trim，与 bridge.ts 的 sessionIdFor(body.group.trim()) 对齐）。
 * @returns 该群的会话 id。
 */
export function sessionIdFor(group) {
  const digest = createHash('sha256').update(String(group).trim(), 'utf8').digest('hex').slice(0, 32)
  return SESSION_PREFIX + digest
}

/**
 * 规则归一：丢掉空 match/空 agent，未知 mode 退回 contains（settings.yaml 是人手可编辑的）。
 * @param rules - 原始规则数组。
 * @returns `[{ match, mode, agent }]`。
 */
export function normalizeRules(rules) {
  if (!Array.isArray(rules)) return []
  const out = []
  for (const raw of rules) {
    if (raw === null || typeof raw !== 'object') continue
    const match = typeof raw.match === 'string' ? raw.match.trim() : ''
    const agent = typeof raw.agent === 'string' ? raw.agent.trim() : ''
    if (match === '' || agent === '') continue
    out.push({ match, mode: RULE_MODES.includes(raw.mode) ? raw.mode : 'contains', agent })
  }
  return out
}

/** 单条规则是否命中群名（contains 不区分大小写；exact 要求完全相等）。 */
export function matchRule(rule, group) {
  const name = String(group ?? '').trim()
  if (name === '') return false
  return rule.mode === 'exact'
    ? name === rule.match
    : name.toLowerCase().includes(rule.match.toLowerCase())
}

/**
 * 群名 → 目标预设 id。**返回空串表示"不干预"**（沿用 dsh-wechat-assistant 原本点名的预设）。
 * 规则按数组顺序自上而下，第一条命中者胜；都没命中则用 defaultAgent。
 * @param config - `{ enabled, defaultAgent, rules }`。
 * @param group - 群名。
 * @returns 预设 id，或空串。
 */
export function routeFor(config, group) {
  if (config === null || typeof config !== 'object') return ''
  if (config.enabled === false) return ''
  const name = String(group ?? '').trim()
  if (name === '') return ''
  for (const rule of normalizeRules(config.rules)) {
    if (matchRule(rule, name)) return rule.agent
  }
  return typeof config.defaultAgent === 'string' ? config.defaultAgent.trim() : ''
}

/**
 * 由「监听群名列表」造一个 `sessionId → 群名` 的解析器。
 * 只认 `wechat-group-` 前缀；索引未命中返回 null（= 不是本插件该管的会话）。
 * @param groups - dsh-wechat-assistant 配置里的监听群名。
 * @returns `(sessionId) => group | null`。
 */
export function createGroupResolver(groups) {
  const index = new Map()
  for (const group of Array.isArray(groups) ? groups : []) {
    const name = String(group).trim()
    if (name !== '') index.set(sessionIdFor(name), name)
  }
  return (sessionId) => {
    const id = String(sessionId ?? '')
    if (!id.startsWith(SESSION_PREFIX)) return null
    return index.get(id) ?? null
  }
}

/**
 * UI 预览：每个监听群最终会走哪个预设（空串 = 不干预）。
 * @param config - 路由配置。
 * @param groups - 监听群名列表。
 * @returns `[{ group, agent, matched }]`，`matched` 为命中它的规则（无则 null）。
 */
export function describeRoutes(config, groups) {
  const rules = normalizeRules(config?.rules)
  const fallback = typeof config?.defaultAgent === 'string' ? config.defaultAgent.trim() : ''
  const off = config?.enabled === false
  return (Array.isArray(groups) ? groups : [])
    .map((raw) => String(raw).trim())
    .filter((group) => group !== '')
    .map((group) => {
      if (off) return { group, agent: '', matched: null }
      const rule = rules.find((candidate) => matchRule(candidate, group)) ?? null
      return { group, agent: rule === null ? fallback : rule.agent, matched: rule }
    })
}
