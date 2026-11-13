// 配置读取：给包装层提供**同步**可用的 `{ config, groups }` 快照。
//   - config：本插件的路由规则（enabled / defaultAgent / rules）；
//   - groups：同事 dsh-wechat-assistant 的监听群名（**只读**，用于 sessionId → 群名 反查）。
//
// 为什么需要一个"同步快照"而不是直接异步读设置服务：
//   包装层要在 `sessions.create` 的调用路径上**同步**决定预设，而设置服务是异步接口。
//   所以快照的刷新（异步）由 host 入口驱动（lib/index.js），包装层只同步读缓存。
//
// 0.2.2-rc.1 变化：`~/.dsh/settings.yaml` 启动时会被 `SettingsForms.importLegacyDocument()`
//   重命名成 `settings.yaml.imported` 并迁入 profile patch，之后直读拿不到内容。
//   因此本模块**不再依赖 settings.yaml 存在**：
//     1) 优先注入值：host 入口用 `setLoader()` 注入一个异步加载器（读设置服务 describe），
//        再 `refresh()` 把当前生效配置喂进 `current`，`get()` 随时可同步读到；
//     2) 兜底直读：若 settings.yaml（或 WECHAT_ROUTER_SETTINGS 覆盖路径）仍存在，则用它——
//        这也正好覆盖单测（指向临时 yaml）与"用户手写 settings.yaml"的场景；
//     3) 都没有则退回默认值（= 不干预，绝不因配置缺失而报错）。
// 写入一律走 host 侧的 settings 服务 / 设置桥，本模块只读。
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { NAMESPACE, WECHAT_NAMESPACE, defaultRouterConfig, normalizeRouterConfig } from './schema.js'

const DEFAULT_TTL_MS = 2000

/**
 * 本机 DSH 的用户设置文件。
 * `WECHAT_ROUTER_SETTINGS` 可覆盖路径（与 eli-mode 的 `ELI_KB_ROOT`、agent-manager 的
 * `AGENT_MANAGER_SETTINGS` 同款做法）：测试要验证"按配置生效"，但不该动用户真实文件。
 */
export function settingsPath() {
  return process.env.WECHAT_ROUTER_SETTINGS || path.join(os.homedir(), '.dsh', 'settings.yaml')
}

function loadDoc() {
  try {
    const doc = yaml.load(readFileSync(settingsPath(), 'utf8'))
    return doc !== null && typeof doc === 'object' ? doc : {}
  } catch {
    return {}
  }
}

/** settings.yaml 是否仍存在（存在才走直读兜底；0.2.2-rc.1 迁移后通常已不存在）。 */
function settingsFileExists() {
  try {
    return existsSync(settingsPath())
  } catch {
    return false
  }
}

/**
 * 把同事的监听群名归一：支持数组与 `;`/`；` 分隔的字符串两种写法（与同事的 normalizeGroups 一致）。
 * @param section - `wechat-assistant` 段（或任何带 `groups` 的对象）。
 * @returns 去重、去空后的群名数组。
 */
function readGroupsSection(section) {
  const groups = section !== null && typeof section === 'object' ? section.groups : undefined
  const items = Array.isArray(groups) ? groups : typeof groups === 'string' ? groups.split(/[;；]/) : []
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]
}

/** 读本插件的完整路由配置（缺字段补默认）。仍走 settings.yaml 直读（测试 / 兜底用）。 */
export function readRouterConfig() {
  return normalizeRouterConfig(loadDoc()[NAMESPACE])
}

/** 读同事的监听群名（只读）。仍走 settings.yaml 直读（测试 / 兜底用）。 */
export function readWechatGroups() {
  return readGroupsSection(loadDoc()[WECHAT_NAMESPACE])
}

/**
 * 造一个带 TTL 的配置快照。
 *
 * `get()` 始终**同步**返回 `{ config, groups }`（包装层 `sessions.create` 路径用，绝不 await）。
 * 值的来源优先级（见模块头注释）：settings.yaml 直读（若存在）→ 注入值（`refresh()` 喂入）→ 默认。
 *
 * 异步刷新由 host 入口驱动：
 *   - `setLoader(fn)`：注入 `fn()` → `Promise<{ config, groups }>`（读设置服务 describe）。
 *   - `refresh()`：调用 loader 更新注入值并重建缓存；启动 / 定期 / 本插件改配置后调用。
 *   - `invalidate()`：清缓存并触发一次后台 refresh（保留旧语义：下一次 get 重新取值）。
 *
 * @param options - TTL 毫秒数（兼容旧的数字入参），或 `{ ttlMs, load }`。
 * @returns `{ get(), invalidate(), refresh(), setLoader() }`。
 */
export function createConfigSnapshot(options = DEFAULT_TTL_MS) {
  const opts = typeof options === 'number' ? { ttlMs: options } : (options && typeof options === 'object' ? options : {})
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS
  let loader = typeof opts.load === 'function' ? opts.load : null
  let current = null // 注入值：由 refresh() 异步填充，跨 TTL 持久
  let cache = { at: 0, config: null, groups: [] }
  let refreshing = false

  // 按优先级解析出"此刻应有的值"（纯同步，供 get/refresh 共用）。
  const resolve = () => {
    if (settingsFileExists()) {
      const doc = loadDoc()
      return { config: normalizeRouterConfig(doc[NAMESPACE]), groups: readGroupsSection(doc[WECHAT_NAMESPACE]) }
    }
    if (current !== null && typeof current === 'object') {
      return { config: normalizeRouterConfig(current.config), groups: readGroupsSection(current) }
    }
    return { config: defaultRouterConfig(), groups: [] }
  }

  const refresh = async () => {
    if (loader === null || refreshing) return cache
    refreshing = true
    try {
      const value = await loader()
      if (value !== null && typeof value === 'object') current = value
    } catch {
      // 读设置服务失败：保留上一次的注入值，不清空（绝不因一次抖动丢配置）。
    } finally {
      refreshing = false
    }
    cache = { at: Date.now(), ...resolve() }
    return cache
  }

  return {
    /** host 入口拿到设置服务后注入异步加载器。 */
    setLoader(fn) {
      loader = typeof fn === 'function' ? fn : null
    },
    /** 同步读：命中缓存用缓存；否则按优先级重算（有 loader 时顺带触发一次后台 refresh）。 */
    get() {
      if (cache.config !== null && Date.now() - cache.at < ttlMs) return cache
      if (loader !== null) void refresh()
      cache = { at: Date.now(), ...resolve() }
      return cache
    },
    /** 本插件保存配置后调用：清缓存 + 触发一次后台 refresh。 */
    invalidate() {
      cache = { at: 0, config: null, groups: [] }
      if (loader !== null) void refresh()
    },
    /** 异步刷新注入值并返回最新快照（启动 / 定期 / 改配置后用）。 */
    refresh,
  }
}
