// 同步读取 ~/.dsh/settings.yaml 的两个段：
//   - `wechat-agent-router`（本插件的路由规则，只读）
//   - `wechat-assistant.groups`（同事的监听群名，**只读**，用于 sessionId → 群名 反查）
//
// 为什么直接读文件而不是走 settings 服务：包装层要在 `sessions.create` 的调用路径上
// **同步**决定预设，而 settings 服务是异步接口；这也带来一个好处——配置改完立刻生效。
// 写入一律走 host 侧的 settings 服务 / 设置桥，本模块只读。
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { NAMESPACE, WECHAT_NAMESPACE, normalizeRouterConfig } from './schema.js'

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

/** 读本插件的完整路由配置（缺字段补默认）。 */
export function readRouterConfig() {
  return normalizeRouterConfig(loadDoc()[NAMESPACE])
}

/**
 * 读同事的监听群名（只读）。
 * 支持数组与 `;`/`；` 分隔的字符串两种写法（与同事的 normalizeGroups 一致）。
 */
export function readWechatGroups() {
  const section = loadDoc()[WECHAT_NAMESPACE]
  const groups = section !== null && typeof section === 'object' ? section.groups : undefined
  const items = Array.isArray(groups) ? groups : typeof groups === 'string' ? groups.split(/[;；]/) : []
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]
}

/**
 * 造一个带 TTL 的配置快照。
 * 包装层每次 `sessions.create` 都会问它，命中快照就不重复读盘；
 * `invalidate()` 用于本插件保存配置后立刻生效。
 * @param ttlMs - 快照有效期。
 * @returns `{ get(), invalidate() }`；`get()` 返回 `{ config, groups }`。
 */
export function createConfigSnapshot(ttlMs = DEFAULT_TTL_MS) {
  let cache = { at: 0, config: null, groups: [] }
  return {
    get() {
      if (cache.config !== null && Date.now() - cache.at < ttlMs) return cache
      const doc = loadDoc()
      cache = {
        at: Date.now(),
        config: normalizeRouterConfig(doc[NAMESPACE]),
        groups: (() => {
          const section = doc[WECHAT_NAMESPACE]
          const groups = section !== null && typeof section === 'object' ? section.groups : undefined
          const items = Array.isArray(groups) ? groups : typeof groups === 'string' ? groups.split(/[;；]/) : []
          return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]
        })(),
      }
      return cache
    },
    invalidate() {
      cache = { at: 0, config: null, groups: [] }
    },
  }
}
