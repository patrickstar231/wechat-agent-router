// 双语文案（zh / en）。键名与界面一一对应，缺键回退中文再回退键名。
export type Dict = Record<string, string>

export const zh: Dict = {
  'section.title': '微信路由',
  'section.desc': '按微信群名决定这条群会话用哪个 Agent 预设。只改"用哪个 Agent"这一件事——监听、收发、归档、引用解析、图片、队列与重试仍然全部由微信助手插件的逻辑负责，本插件不碰它一行代码。',

  'action.refresh': '刷新',
  'action.save': '保存',
  'action.saving': '保存中…',
  'action.reconcile': '立即应用',
  'action.reconciling': '应用中…',
  'action.addRule': '新增规则',
  'action.remove': '删除',
  'action.up': '上移',
  'action.down': '下移',

  'state.loading': '加载中…',
  'state.loadFailed': '读取失败：{msg}',
  'state.saved': '已保存',
  'state.saveFailed': '保存失败：{msg}',
  'state.unsaved': '有未保存的更改',

  'switch.enabled': '启用按群名路由',
  'switch.enabledDesc': '关闭后完全不干预，群会话仍用微信助手原本指定的 Agent 预设。',

  'fallback.label': '兜底 Agent',
  'fallback.desc': '所有规则都没命中时用哪个 Agent。选「不干预」表示保持现状。',
  'fallback.none': '不干预（保持微信助手原样）',

  'rules.title': '路由规则',
  'rules.desc': '自上而下匹配，第一条命中者生效。群名精确或包含匹配；命中后该群的会话改用指定 Agent。',
  'rules.empty': '还没有规则。新增一条即可让匹配的群走你的 Agent。',
  'rules.mode.contains': '包含',
  'rules.mode.exact': '精确',
  'rules.matchPlaceholder': '群名关键字，例如 对接',
  'rules.agentPlaceholder': '选择 Agent',

  'sessions.title': '监听群现状',
  'sessions.desc': '「当前」是该群会话实际在跑的 Agent 预设，「目标」是路由算出来的结果。只对还没聊过（空白）的会话生效；已有历史的会话 DSH 不允许换预设，会一直保持原样。',
  'sessions.col.group': '群名',
  'sessions.col.current': '当前',
  'sessions.col.wanted': '目标',
  'sessions.col.state': '状态',
  'sessions.empty': '还没有群会话。等该群收到第一条消息、或微信助手启动时同步一次，这里就会出现。',
  'sessions.error': '读取会话失败：{msg}',
  'sessions.unknownGroup': '(不在监听列表)',
  'sessions.notSet': '(未指定)',

  'status.aligned': '一致',
  'status.pending': '待应用',
  'status.locked': '已有历史',
  'status.running': '处理中',

  'presets.error': '读取 Agent 预设名单失败：{msg}',
  'presets.broken': '该预设无法挂载：{reason}',
  'presets.default': '默认',

  'notify.reconcileApplied': '已应用 {n} 个空白会话。',
  'notify.reconcileSkipped': '跳过 {n} 个（已有历史或正在处理）。',
  'notify.reconcileFailed': '失败 {n} 个：{detail}',
  'notify.reconcileNone': '没有需要补正的空白会话。',
  'notify.notWrapped': '包装未生效：本插件没能接管 sessions.create，路由不会起作用。',

  'hint.settingsPath': '配置文件：{path}（本插件的段为 wechat-agent-router）',
  'hint.restart': '改动对新会话即时生效，无需重启；已经在跑的会话不受影响。',
}

export const en: Dict = {
  'section.title': 'WeChat routing',
  'section.desc': 'Choose which agent preset a group session runs, based on the group name. Only that one value is touched — listening, sending, archiving, quote/image parsing, queues and retries stay entirely with the WeChat assistant plugin; this plugin changes none of its code.',

  'action.refresh': 'Refresh',
  'action.save': 'Save',
  'action.saving': 'Saving…',
  'action.reconcile': 'Apply now',
  'action.reconciling': 'Applying…',
  'action.addRule': 'Add rule',
  'action.remove': 'Remove',
  'action.up': 'Move up',
  'action.down': 'Move down',

  'state.loading': 'Loading…',
  'state.loadFailed': 'Load failed: {msg}',
  'state.saved': 'Saved',
  'state.saveFailed': 'Save failed: {msg}',
  'state.unsaved': 'Unsaved changes',

  'switch.enabled': 'Enable group-name routing',
  'switch.enabledDesc': 'When off, nothing is touched and group sessions keep the agent preset the WeChat assistant named.',

  'fallback.label': 'Fallback agent',
  'fallback.desc': 'Used when no rule matches. Pick "leave as is" to keep the current behaviour.',
  'fallback.none': 'Leave as is (WeChat assistant default)',

  'rules.title': 'Routing rules',
  'rules.desc': 'Evaluated top-down; the first match wins. Match the group name exactly or by substring, then send that group to the chosen agent.',
  'rules.empty': 'No rules yet. Add one to route matching groups to your agent.',
  'rules.mode.contains': 'contains',
  'rules.mode.exact': 'exact',
  'rules.matchPlaceholder': 'group name keyword, e.g. 对接',
  'rules.agentPlaceholder': 'pick an agent',

  'sessions.title': 'Watched groups',
  'sessions.desc': '"Current" is the preset that group session actually runs; "target" is what routing resolves to. Only blank sessions (no turn yet) can switch — DSH refuses to change a preset once a conversation has history, so those stay as they are.',
  'sessions.col.group': 'Group',
  'sessions.col.current': 'Current',
  'sessions.col.wanted': 'Target',
  'sessions.col.state': 'State',
  'sessions.empty': 'No group sessions yet. They appear after a group receives its first message, or after the WeChat assistant syncs on startup.',
  'sessions.error': 'Could not read sessions: {msg}',
  'sessions.unknownGroup': '(not in the watch list)',
  'sessions.notSet': '(unset)',

  'status.aligned': 'aligned',
  'status.pending': 'pending',
  'status.locked': 'has history',
  'status.running': 'running',

  'presets.error': 'Could not read the preset roster: {msg}',
  'presets.broken': 'This preset cannot be mounted: {reason}',
  'presets.default': 'default',

  'notify.reconcileApplied': 'Applied to {n} blank session(s).',
  'notify.reconcileSkipped': 'Skipped {n} (history or busy).',
  'notify.reconcileFailed': 'Failed {n}: {detail}',
  'notify.reconcileNone': 'No blank session needed fixing.',
  'notify.notWrapped': 'Wrapping is inactive: this plugin could not take over sessions.create, so routing has no effect.',

  'hint.settingsPath': 'Config file: {path} (this plugin\'s section is wechat-agent-router)',
  'hint.restart': 'Changes apply to new sessions immediately, no restart needed; running sessions are untouched.',
}

export const LOCALES = { zh, en }

/** 取词函数：按当前语言取，缺失回退中文，再回退键名。 */
export function makeT(dict: Dict | undefined, fallback: Dict = zh) {
  return (key: string, vars?: Record<string, string | number>): string => {
    const template = (dict !== undefined ? dict[key] : undefined) ?? fallback[key] ?? key
    if (vars === undefined) return template
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(vars[name] ?? ''))
  }
}
