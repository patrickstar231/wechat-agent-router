// 浏览器半入口：注入样式 → 注册双语 → 注册「微信路由」设置分区。
//
// 只有一个入口（独立分区），不注入到任何官方卡片：本插件改的是"会话用哪个预设"，
// 与 Agent 预设卡片没有交互关系，没必要碰 DOM。
import React from 'react'
import { RouterSection } from './RouterSection.js'
import { LOCALES, makeT, zh } from './locales.js'
import { STYLE_ID, css } from './styles.js'

export const name = 'dsh-wechat-agent-router-client'
export const inject = ['slots']

const NS = 'wechat-agent-router'
const SECTION_LABEL = '微信路由'

const interpolate = (template: string, vars?: Record<string, string | number>) => (
  vars === undefined ? template : template.replace(/\{(\w+)\}/g, (_match, key: string) => String(vars[key] ?? ''))
)

/** slot 渲染器会按注册时的 locale 命名空间给我们 t；取不到就退回中文词典。 */
function makeSectionT(props: any) {
  const fallback = makeT(zh)
  return (key: string, vars?: Record<string, string | number>) => {
    const raw = typeof props?.t === 'function' ? props.t(key) : fallback(key)
    return interpolate(typeof raw === 'string' ? raw : String(raw), vars)
  }
}

export function apply(ctx: any) {
  ctx.effect(() => {
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = css
      document.head.appendChild(style)
    }
    return () => document.getElementById(STYLE_ID)?.remove()
  }, 'wechat-agent-router 样式')

  const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
  if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
    locale.register(NS, LOCALES)
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NS,
    order: 141,
    label: SECTION_LABEL,
    locale: NS,
  }, (props: any) => <RouterSection t={makeSectionT(props)} />))
}
