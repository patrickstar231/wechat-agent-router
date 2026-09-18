// 设置分区主组件「微信路由」：规则表 + 兜底 Agent + 监听群现状。
//
// 与 agent-manager 一样的读写策略：配置只经 host 侧的 loopback 设置桥读写（逐个字段写，
// 不整段覆盖，避免抹掉 settings.yaml 里别人加的字段）；「立即应用」调 host 的 reconcile，
// 把"还没聊过但预设不对"的群会话切到路由目标。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  bootstrap,
  readSettings,
  reconcile,
  saveConfig,
  type Bootstrap,
  type PresetOption,
  type RouteRule,
  type SessionRow,
} from './api.js'

type Draft = { enabled: boolean; defaultAgent: string; rules: RouteRule[] }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function normalizeRule(raw: any): RouteRule {
  return {
    match: typeof raw?.match === 'string' ? raw.match : '',
    mode: raw?.mode === 'exact' ? 'exact' : 'contains',
    agent: typeof raw?.agent === 'string' ? raw.agent : '',
  }
}

function draftOf(value: { enabled?: boolean; defaultAgent?: string; rules?: RouteRule[] } | undefined): Draft {
  return {
    enabled: value?.enabled !== false,
    defaultAgent: typeof value?.defaultAgent === 'string' ? value.defaultAgent : '',
    rules: Array.isArray(value?.rules) ? value.rules.map(normalizeRule) : [],
  }
}

function presetLabel(preset: PresetOption) {
  return preset.name !== '' && preset.name !== preset.id ? `${preset.name}（${preset.id}）` : preset.id
}

/** 一个群当前该显示什么状态。 */
function sessionState(row: SessionRow) {
  if (row.group === null) return { tone: 'plain' as const, key: 'sessions.unknownGroup' }
  if (row.running) return { tone: 'warn' as const, key: 'status.running' }
  if (row.aligned) return { tone: 'ok' as const, key: 'status.aligned' }
  if (!row.blank) return { tone: 'danger' as const, key: 'status.locked' }
  return { tone: 'warn' as const, key: 'status.pending' }
}

export function RouterSection({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [draft, setDraft] = useState<Draft>(draftOf(undefined))
  const [baseline, setBaseline] = useState<Draft>(draftOf(undefined))
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [writable, setWritable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'' | 'save' | 'reconcile'>('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<{ tone: '' | 'ok' | 'warn' | 'error'; text: string }>({ tone: '', text: '' })

  // t 由父级 slot 每次渲染都重建新引用，不能进 load 的依赖，否则 DSH 重渲染 section
  // 时会反复触发 load() 覆盖未保存的输入。用 ref 取最新 t，load 仅在挂载时跑一次。
  const tRef = useRef(t)
  tRef.current = t

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [data, settings] = await Promise.all([bootstrap(), readSettings()])
      const next = draftOf(settings.value)
      setBoot(data)
      setDraft(next)
      setBaseline(next)
      setRevision(settings.revision)
      setWritable(settings.writable !== false)
      setError(data.sessionsError === '' ? '' : tRef.current('sessions.error', { msg: data.sessionsError }))
    } catch (cause) {
      setError(tRef.current('state.loadFailed', { msg: messageOf(cause) }))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline])
  const presets = boot?.presets ?? []
  const broken = useMemo(() => new Map(presets.filter((preset) => preset.broken !== '').map((preset) => [preset.id, preset])), [presets])

  const patch = (next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next }))
  const patchRule = (index: number, next: Partial<RouteRule>) => setDraft((prev) => ({
    ...prev,
    rules: prev.rules.map((rule, at) => (at === index ? { ...rule, ...next } : rule)),
  }))
  const addRule = () => setDraft((prev) => ({ ...prev, rules: [...prev.rules, { match: '', mode: 'contains', agent: '' }] }))
  const removeRule = (index: number) => setDraft((prev) => ({ ...prev, rules: prev.rules.filter((_rule, at) => at !== index) }))
  const moveRule = (index: number, delta: number) => setDraft((prev) => {
    const at = index + delta
    if (at < 0 || at >= prev.rules.length) return prev
    const rules = [...prev.rules]
    const [moved] = rules.splice(index, 1)
    rules.splice(at, 0, moved)
    return { ...prev, rules }
  })

  const reportReconcile = (result: { applied: unknown[]; skipped: unknown[]; failed: { group: string; agent: string; error: string }[] }) => {
    const parts: string[] = []
    parts.push(result.applied.length === 0 ? t('notify.reconcileNone') : t('notify.reconcileApplied', { n: result.applied.length }))
    if (result.skipped.length > 0) parts.push(t('notify.reconcileSkipped', { n: result.skipped.length }))
    if (result.failed.length > 0) {
      parts.push(t('notify.reconcileFailed', { n: result.failed.length, detail: result.failed.map((row) => `${row.group}：${row.error}`).join('；') }))
    }
    setStatus({ tone: result.failed.length > 0 ? 'error' : 'ok', text: parts.join(' ') })
  }

  const save = async () => {
    setBusy('save')
    setStatus({ tone: '', text: '' })
    try {
      const response = await saveConfig(draft, revision)
      setRevision(response.revision)
      setBaseline(draft)
      if (response.reconciled !== undefined) reportReconcile(response.reconciled)
      else setStatus({ tone: 'ok', text: t('state.saved') })
      await load()
    } catch (cause) {
      setStatus({ tone: 'error', text: t('state.saveFailed', { msg: messageOf(cause) }) })
    } finally {
      setBusy('')
    }
  }

  const applyNow = async () => {
    setBusy('reconcile')
    setStatus({ tone: '', text: '' })
    try {
      reportReconcile(await reconcile())
      await load()
    } catch (cause) {
      setStatus({ tone: 'error', text: t('state.saveFailed', { msg: messageOf(cause) }) })
    } finally {
      setBusy('')
    }
  }

  const refresh = () => {
    if (dirty && typeof window.confirm === 'function' && !window.confirm(t('state.unsaved'))) return
    void load()
  }

  const disabled = loading || busy !== '' || !writable

  return (
    <div className="wr-page">
      <div className="wr-head">
        <div>
          <h2 className="wr-title">{t('section.title')}</h2>
          <p className="wr-desc">{t('section.desc')}</p>
        </div>
        <div className="wr-actions">
          <button type="button" className="wr-button" onClick={refresh} disabled={loading || busy !== ''}>{t('action.refresh')}</button>
          <button type="button" className="wr-button" onClick={() => void applyNow()} disabled={disabled}>
            {busy === 'reconcile' ? t('action.reconciling') : t('action.reconcile')}
          </button>
          <button type="button" className="wr-button" data-primary="true" onClick={() => void save()} disabled={disabled || !dirty}>
            {busy === 'save' ? t('action.saving') : t('action.save')}
          </button>
        </div>
      </div>

      {error !== '' ? <div className="wr-error">{error}</div> : null}
      {status.text !== '' ? (
        <div className={status.tone === 'error' ? 'wr-error' : status.tone === 'warn' ? 'wr-notice' : 'wr-ok'}>{status.text}</div>
      ) : null}
      {boot !== null && !boot.wrapped ? <div className="wr-notice">{t('notify.notWrapped')}</div> : null}
      {!writable ? <div className="wr-notice">{t('state.loadFailed', { msg: 'read-only' })}</div> : null}
      {loading && boot === null ? <div className="wr-muted">{t('state.loading')}</div> : null}

      <div className="wr-panel">
        <div className="wr-switch-row">
          <span className="wr-switch-text">
            <span className="wr-switch-name">{t('switch.enabled')}</span>
            <span className="wr-switch-desc">{t('switch.enabledDesc')}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            aria-label={t('switch.enabled')}
            className="wr-switch"
            disabled={disabled}
            onClick={() => patch({ enabled: !draft.enabled })}
          >
            <span className="wr-switch-thumb" aria-hidden="true" />
          </button>
        </div>

        <div className="wr-field">
          <label className="wr-label" htmlFor="wr-fallback">{t('fallback.label')}</label>
          <div className="wr-row">
            <select
              id="wr-fallback"
              className="wr-select"
              value={draft.defaultAgent}
              disabled={disabled}
              onChange={(event) => patch({ defaultAgent: event.target.value })}
            >
              <option value="">{t('fallback.none')}</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id} disabled={preset.broken !== ''}>
                  {presetLabel(preset)}{preset.broken !== '' ? ` — ${t('presets.broken', { reason: preset.broken })}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="wr-help">{t('fallback.desc')}</div>
        </div>
      </div>

      <div className="wr-panel">
        <h3 className="wr-panel-title">{t('rules.title')}</h3>
        <div className="wr-help">{t('rules.desc')}</div>
        {boot !== null && boot.presetsError !== '' ? <div className="wr-error">{t('presets.error', { msg: boot.presetsError })}</div> : null}
        {draft.rules.length === 0 ? <div className="wr-muted">{t('rules.empty')}</div> : null}
        {draft.rules.map((rule, index) => (
          <div className="wr-rule" key={`rule-${index}`}>
            <div className="wr-rule-head">
              <select
                className="wr-select"
                aria-label={t('rules.mode.contains')}
                value={rule.mode}
                disabled={disabled}
                onChange={(event) => patchRule(index, { mode: event.target.value === 'exact' ? 'exact' : 'contains' })}
              >
                <option value="contains">{t('rules.mode.contains')}</option>
                <option value="exact">{t('rules.mode.exact')}</option>
              </select>
              <input
                className="wr-input"
                value={rule.match}
                placeholder={t('rules.matchPlaceholder')}
                disabled={disabled}
                onChange={(event) => patchRule(index, { match: event.target.value })}
              />
              <span className="wr-arrow">→</span>
              <select
                className="wr-select"
                aria-label={t('rules.agentPlaceholder')}
                value={rule.agent}
                disabled={disabled}
                onChange={(event) => patchRule(index, { agent: event.target.value })}
              >
                <option value="">{t('rules.agentPlaceholder')}</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id} disabled={preset.broken !== ''}>
                    {presetLabel(preset)}
                  </option>
                ))}
              </select>
              <button type="button" className="wr-button" onClick={() => moveRule(index, -1)} disabled={disabled || index === 0} aria-label={t('action.up')}>↑</button>
              <button type="button" className="wr-button" onClick={() => moveRule(index, 1)} disabled={disabled || index === draft.rules.length - 1} aria-label={t('action.down')}>↓</button>
              <button type="button" className="wr-button" onClick={() => removeRule(index)} disabled={disabled}>{t('action.remove')}</button>
            </div>
            {broken.has(rule.agent) ? <div className="wr-error">{t('presets.broken', { reason: broken.get(rule.agent)?.broken ?? '' })}</div> : null}
          </div>
        ))}
        <div className="wr-actions">
          <button type="button" className="wr-button" onClick={addRule} disabled={disabled}>{t('action.addRule')}</button>
        </div>
      </div>

      <div className="wr-panel">
        <h3 className="wr-panel-title">{t('sessions.title')}</h3>
        <div className="wr-help">{t('sessions.desc')}</div>
        {boot !== null && boot.sessions.length === 0 ? <div className="wr-muted">{t('sessions.empty')}</div> : null}
        {boot !== null && boot.sessions.length > 0 ? (
          <div className="wr-table">
            <div className="wr-tr" data-head="true">
              <span>{t('sessions.col.group')}</span>
              <span>{t('sessions.col.current')}</span>
              <span>{t('sessions.col.wanted')}</span>
              <span>{t('sessions.col.state')}</span>
            </div>
            {boot.sessions.map((row) => {
              const state = sessionState(row)
              return (
                <div className="wr-tr" key={row.sessionId}>
                  <span className="wr-mono">{row.group ?? t('sessions.unknownGroup')}</span>
                  <span className="wr-mono">{row.preset === '' ? t('sessions.notSet') : row.preset}</span>
                  <span className="wr-mono">{row.wanted === '' ? '—' : row.wanted}</span>
                  <span><span className="wr-badge" data-tone={state.tone}>{t(state.key)}</span></span>
                </div>
              )
            })}
          </div>
        ) : null}
        <div className="wr-help">{t('hint.restart')}</div>
        {boot !== null ? <div className="wr-help">{t('hint.settingsPath', { path: boot.settingsPath })}</div> : null}
      </div>
    </div>
  )
}
