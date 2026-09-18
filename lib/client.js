window.__ModuleLoader__.load({
  id: "dsh-wechat-agent-router",
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let react = require("react");
react = __toESM(react, 1);
//#region src/api.ts
const API = "/wechat-agent-router/api";
async function post(path, body) {
	const response = await fetch(API + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {})
	});
	const payload = await response.json().catch(() => ({
		ok: false,
		error: `HTTP ${response.status}`
	}));
	if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
	return payload;
}
/** 读规则、监听群现状与可选预设名单。 */
async function bootstrap() {
	const payload = await post("/bootstrap", {});
	if (!payload.ok) throw new Error(payload.error ?? "bootstrap failed");
	return payload;
}
/** 立即补正：把"还没聊过但预设不对"的群会话切到路由目标。 */
async function reconcile() {
	const payload = await post("/reconcile", {});
	if (!payload.ok) throw new Error(payload.error ?? "reconcile failed");
	return payload;
}
/** 读设置（含 revision，写入时用于冲突检测）。 */
async function readSettings() {
	const payload = await post("/settings/describe", {});
	if (!payload.ok) throw new Error(payload.error ?? "settings unavailable");
	return payload.value;
}
/**
* 逐个字段写（不整段覆盖），这样 settings.yaml 里别人加的未知字段不会被抹掉。
* 遇到 revision 冲突自动用最新 revision 重试一次：面板开着时手改 yaml 也能保存成功。
*/
async function saveConfig(config, expectedRevision) {
	const ops = [
		{
			op: "set",
			path: ["enabled"],
			value: config.enabled
		},
		{
			op: "set",
			path: ["defaultAgent"],
			value: config.defaultAgent
		},
		{
			op: "set",
			path: ["rules"],
			value: config.rules
		}
	];
	const attempt = async (revision) => post("/settings/mutate", {
		ops,
		...revision === void 0 ? {} : { expectedRevision: revision }
	});
	let payload = await attempt(expectedRevision);
	if (!payload.ok && payload.code === "settings-conflict") payload = await attempt((await readSettings()).revision);
	if (!payload.ok) throw new Error(payload.message ?? payload.error ?? "save failed");
	return payload.value;
}
//#endregion
//#region src/RouterSection.tsx
const messageOf = (error) => error instanceof Error ? error.message : String(error);
function normalizeRule(raw) {
	return {
		match: typeof raw?.match === "string" ? raw.match : "",
		mode: raw?.mode === "exact" ? "exact" : "contains",
		agent: typeof raw?.agent === "string" ? raw.agent : ""
	};
}
function draftOf(value) {
	return {
		enabled: value?.enabled !== false,
		defaultAgent: typeof value?.defaultAgent === "string" ? value.defaultAgent : "",
		rules: Array.isArray(value?.rules) ? value.rules.map(normalizeRule) : []
	};
}
function presetLabel(preset) {
	return preset.name !== "" && preset.name !== preset.id ? `${preset.name}（${preset.id}）` : preset.id;
}
/** 一个群当前该显示什么状态。 */
function sessionState(row) {
	if (row.group === null) return {
		tone: "plain",
		key: "sessions.unknownGroup"
	};
	if (row.running) return {
		tone: "warn",
		key: "status.running"
	};
	if (row.aligned) return {
		tone: "ok",
		key: "status.aligned"
	};
	if (!row.blank) return {
		tone: "danger",
		key: "status.locked"
	};
	return {
		tone: "warn",
		key: "status.pending"
	};
}
function RouterSection({ t }) {
	const [boot, setBoot] = (0, react.useState)(null);
	const [draft, setDraft] = (0, react.useState)(draftOf(void 0));
	const [baseline, setBaseline] = (0, react.useState)(draftOf(void 0));
	const [revision, setRevision] = (0, react.useState)(void 0);
	const [writable, setWritable] = (0, react.useState)(true);
	const [loading, setLoading] = (0, react.useState)(true);
	const [busy, setBusy] = (0, react.useState)("");
	const [error, setError] = (0, react.useState)("");
	const [status, setStatus] = (0, react.useState)({
		tone: "",
		text: ""
	});
	const tRef = (0, react.useRef)(t);
	tRef.current = t;
	const load = (0, react.useCallback)(async () => {
		setLoading(true);
		try {
			const [data, settings] = await Promise.all([bootstrap(), readSettings()]);
			const next = draftOf(settings.value);
			setBoot(data);
			setDraft(next);
			setBaseline(next);
			setRevision(settings.revision);
			setWritable(settings.writable !== false);
			setError(data.sessionsError === "" ? "" : tRef.current("sessions.error", { msg: data.sessionsError }));
		} catch (cause) {
			setError(tRef.current("state.loadFailed", { msg: messageOf(cause) }));
		} finally {
			setLoading(false);
		}
	}, []);
	(0, react.useEffect)(() => {
		load();
	}, []);
	const dirty = (0, react.useMemo)(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);
	const presets = boot?.presets ?? [];
	const broken = (0, react.useMemo)(() => new Map(presets.filter((preset) => preset.broken !== "").map((preset) => [preset.id, preset])), [presets]);
	const patch = (next) => setDraft((prev) => ({
		...prev,
		...next
	}));
	const patchRule = (index, next) => setDraft((prev) => ({
		...prev,
		rules: prev.rules.map((rule, at) => at === index ? {
			...rule,
			...next
		} : rule)
	}));
	const addRule = () => setDraft((prev) => ({
		...prev,
		rules: [...prev.rules, {
			match: "",
			mode: "contains",
			agent: ""
		}]
	}));
	const removeRule = (index) => setDraft((prev) => ({
		...prev,
		rules: prev.rules.filter((_rule, at) => at !== index)
	}));
	const moveRule = (index, delta) => setDraft((prev) => {
		const at = index + delta;
		if (at < 0 || at >= prev.rules.length) return prev;
		const rules = [...prev.rules];
		const [moved] = rules.splice(index, 1);
		rules.splice(at, 0, moved);
		return {
			...prev,
			rules
		};
	});
	const reportReconcile = (result) => {
		const parts = [];
		parts.push(result.applied.length === 0 ? t("notify.reconcileNone") : t("notify.reconcileApplied", { n: result.applied.length }));
		if (result.skipped.length > 0) parts.push(t("notify.reconcileSkipped", { n: result.skipped.length }));
		if (result.failed.length > 0) parts.push(t("notify.reconcileFailed", {
			n: result.failed.length,
			detail: result.failed.map((row) => `${row.group}：${row.error}`).join("；")
		}));
		setStatus({
			tone: result.failed.length > 0 ? "error" : "ok",
			text: parts.join(" ")
		});
	};
	const save = async () => {
		setBusy("save");
		setStatus({
			tone: "",
			text: ""
		});
		try {
			const response = await saveConfig(draft, revision);
			setRevision(response.revision);
			setBaseline(draft);
			if (response.reconciled !== void 0) reportReconcile(response.reconciled);
			else setStatus({
				tone: "ok",
				text: t("state.saved")
			});
			await load();
		} catch (cause) {
			setStatus({
				tone: "error",
				text: t("state.saveFailed", { msg: messageOf(cause) })
			});
		} finally {
			setBusy("");
		}
	};
	const applyNow = async () => {
		setBusy("reconcile");
		setStatus({
			tone: "",
			text: ""
		});
		try {
			reportReconcile(await reconcile());
			await load();
		} catch (cause) {
			setStatus({
				tone: "error",
				text: t("state.saveFailed", { msg: messageOf(cause) })
			});
		} finally {
			setBusy("");
		}
	};
	const refresh = () => {
		if (dirty && typeof window.confirm === "function" && !window.confirm(t("state.unsaved"))) return;
		load();
	};
	const disabled = loading || busy !== "" || !writable;
	return /* @__PURE__ */ react.default.createElement("div", { className: "wr-page" }, /* @__PURE__ */ react.default.createElement("div", { className: "wr-head" }, /* @__PURE__ */ react.default.createElement("div", null, /* @__PURE__ */ react.default.createElement("h2", { className: "wr-title" }, t("section.title")), /* @__PURE__ */ react.default.createElement("p", { className: "wr-desc" }, t("section.desc"))), /* @__PURE__ */ react.default.createElement("div", { className: "wr-actions" }, /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		className: "wr-button",
		onClick: refresh,
		disabled: loading || busy !== ""
	}, t("action.refresh")), /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		className: "wr-button",
		onClick: () => void applyNow(),
		disabled
	}, busy === "reconcile" ? t("action.reconciling") : t("action.reconcile")), /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		className: "wr-button",
		"data-primary": "true",
		onClick: () => void save(),
		disabled: disabled || !dirty
	}, busy === "save" ? t("action.saving") : t("action.save")))), error !== "" ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-error" }, error) : null, status.text !== "" ? /* @__PURE__ */ react.default.createElement("div", { className: status.tone === "error" ? "wr-error" : status.tone === "warn" ? "wr-notice" : "wr-ok" }, status.text) : null, boot !== null && !boot.wrapped ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-notice" }, t("notify.notWrapped")) : null, !writable ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-notice" }, t("state.loadFailed", { msg: "read-only" })) : null, loading && boot === null ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-muted" }, t("state.loading")) : null, /* @__PURE__ */ react.default.createElement("div", { className: "wr-panel" }, /* @__PURE__ */ react.default.createElement("div", { className: "wr-switch-row" }, /* @__PURE__ */ react.default.createElement("span", { className: "wr-switch-text" }, /* @__PURE__ */ react.default.createElement("span", { className: "wr-switch-name" }, t("switch.enabled")), /* @__PURE__ */ react.default.createElement("span", { className: "wr-switch-desc" }, t("switch.enabledDesc"))), /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		role: "switch",
		"aria-checked": draft.enabled,
		"aria-label": t("switch.enabled"),
		className: "wr-switch",
		disabled,
		onClick: () => patch({ enabled: !draft.enabled })
	}, /* @__PURE__ */ react.default.createElement("span", {
		className: "wr-switch-thumb",
		"aria-hidden": "true"
	}))), /* @__PURE__ */ react.default.createElement("div", { className: "wr-field" }, /* @__PURE__ */ react.default.createElement("label", {
		className: "wr-label",
		htmlFor: "wr-fallback"
	}, t("fallback.label")), /* @__PURE__ */ react.default.createElement("div", { className: "wr-row" }, /* @__PURE__ */ react.default.createElement("select", {
		id: "wr-fallback",
		className: "wr-select",
		value: draft.defaultAgent,
		disabled,
		onChange: (event) => patch({ defaultAgent: event.target.value })
	}, /* @__PURE__ */ react.default.createElement("option", { value: "" }, t("fallback.none")), presets.map((preset) => /* @__PURE__ */ react.default.createElement("option", {
		key: preset.id,
		value: preset.id,
		disabled: preset.broken !== ""
	}, presetLabel(preset), preset.broken !== "" ? ` — ${t("presets.broken", { reason: preset.broken })}` : "")))), /* @__PURE__ */ react.default.createElement("div", { className: "wr-help" }, t("fallback.desc")))), /* @__PURE__ */ react.default.createElement("div", { className: "wr-panel" }, /* @__PURE__ */ react.default.createElement("h3", { className: "wr-panel-title" }, t("rules.title")), /* @__PURE__ */ react.default.createElement("div", { className: "wr-help" }, t("rules.desc")), boot !== null && boot.presetsError !== "" ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-error" }, t("presets.error", { msg: boot.presetsError })) : null, draft.rules.length === 0 ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-muted" }, t("rules.empty")) : null, draft.rules.map((rule, index) => /* @__PURE__ */ react.default.createElement("div", {
		className: "wr-rule",
		key: `rule-${index}`
	}, /* @__PURE__ */ react.default.createElement("div", { className: "wr-rule-head" }, /* @__PURE__ */ react.default.createElement("select", {
		className: "wr-select",
		"aria-label": t("rules.mode.contains"),
		value: rule.mode,
		disabled,
		onChange: (event) => patchRule(index, { mode: event.target.value === "exact" ? "exact" : "contains" })
	}, /* @__PURE__ */ react.default.createElement("option", { value: "contains" }, t("rules.mode.contains")), /* @__PURE__ */ react.default.createElement("option", { value: "exact" }, t("rules.mode.exact"))), /* @__PURE__ */ react.default.createElement("input", {
		className: "wr-input",
		value: rule.match,
		placeholder: t("rules.matchPlaceholder"),
		disabled,
		onChange: (event) => patchRule(index, { match: event.target.value })
	}), /* @__PURE__ */ react.default.createElement("span", { className: "wr-arrow" }, "→"), /* @__PURE__ */ react.default.createElement("select", {
		className: "wr-select",
		"aria-label": t("rules.agentPlaceholder"),
		value: rule.agent,
		disabled,
		onChange: (event) => patchRule(index, { agent: event.target.value })
	}, /* @__PURE__ */ react.default.createElement("option", { value: "" }, t("rules.agentPlaceholder")), presets.map((preset) => /* @__PURE__ */ react.default.createElement("option", {
		key: preset.id,
		value: preset.id,
		disabled: preset.broken !== ""
	}, presetLabel(preset)))), /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		className: "wr-button",
		onClick: () => moveRule(index, -1),
		disabled: disabled || index === 0,
		"aria-label": t("action.up")
	}, "↑"), /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		className: "wr-button",
		onClick: () => moveRule(index, 1),
		disabled: disabled || index === draft.rules.length - 1,
		"aria-label": t("action.down")
	}, "↓"), /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		className: "wr-button",
		onClick: () => removeRule(index),
		disabled
	}, t("action.remove"))), broken.has(rule.agent) ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-error" }, t("presets.broken", { reason: broken.get(rule.agent)?.broken ?? "" })) : null)), /* @__PURE__ */ react.default.createElement("div", { className: "wr-actions" }, /* @__PURE__ */ react.default.createElement("button", {
		type: "button",
		className: "wr-button",
		onClick: addRule,
		disabled
	}, t("action.addRule")))), /* @__PURE__ */ react.default.createElement("div", { className: "wr-panel" }, /* @__PURE__ */ react.default.createElement("h3", { className: "wr-panel-title" }, t("sessions.title")), /* @__PURE__ */ react.default.createElement("div", { className: "wr-help" }, t("sessions.desc")), boot !== null && boot.sessions.length === 0 ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-muted" }, t("sessions.empty")) : null, boot !== null && boot.sessions.length > 0 ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-table" }, /* @__PURE__ */ react.default.createElement("div", {
		className: "wr-tr",
		"data-head": "true"
	}, /* @__PURE__ */ react.default.createElement("span", null, t("sessions.col.group")), /* @__PURE__ */ react.default.createElement("span", null, t("sessions.col.current")), /* @__PURE__ */ react.default.createElement("span", null, t("sessions.col.wanted")), /* @__PURE__ */ react.default.createElement("span", null, t("sessions.col.state"))), boot.sessions.map((row) => {
		const state = sessionState(row);
		return /* @__PURE__ */ react.default.createElement("div", {
			className: "wr-tr",
			key: row.sessionId
		}, /* @__PURE__ */ react.default.createElement("span", { className: "wr-mono" }, row.group ?? t("sessions.unknownGroup")), /* @__PURE__ */ react.default.createElement("span", { className: "wr-mono" }, row.preset === "" ? t("sessions.notSet") : row.preset), /* @__PURE__ */ react.default.createElement("span", { className: "wr-mono" }, row.wanted === "" ? "—" : row.wanted), /* @__PURE__ */ react.default.createElement("span", null, /* @__PURE__ */ react.default.createElement("span", {
			className: "wr-badge",
			"data-tone": state.tone
		}, t(state.key))));
	})) : null, /* @__PURE__ */ react.default.createElement("div", { className: "wr-help" }, t("hint.restart")), boot !== null ? /* @__PURE__ */ react.default.createElement("div", { className: "wr-help" }, t("hint.settingsPath", { path: boot.settingsPath })) : null));
}
//#endregion
//#region src/locales.ts
const zh = {
	"section.title": "微信路由",
	"section.desc": "按微信群名决定这条群会话用哪个 Agent 预设。只改\"用哪个 Agent\"这一件事——监听、收发、归档、引用解析、图片、队列与重试仍然全部由微信助手插件的逻辑负责，本插件不碰它一行代码。",
	"action.refresh": "刷新",
	"action.save": "保存",
	"action.saving": "保存中…",
	"action.reconcile": "立即应用",
	"action.reconciling": "应用中…",
	"action.addRule": "新增规则",
	"action.remove": "删除",
	"action.up": "上移",
	"action.down": "下移",
	"state.loading": "加载中…",
	"state.loadFailed": "读取失败：{msg}",
	"state.saved": "已保存",
	"state.saveFailed": "保存失败：{msg}",
	"state.unsaved": "有未保存的更改",
	"switch.enabled": "启用按群名路由",
	"switch.enabledDesc": "关闭后完全不干预，群会话仍用微信助手原本指定的 Agent 预设。",
	"fallback.label": "兜底 Agent",
	"fallback.desc": "所有规则都没命中时用哪个 Agent。选「不干预」表示保持现状。",
	"fallback.none": "不干预（保持微信助手原样）",
	"rules.title": "路由规则",
	"rules.desc": "自上而下匹配，第一条命中者生效。群名精确或包含匹配；命中后该群的会话改用指定 Agent。",
	"rules.empty": "还没有规则。新增一条即可让匹配的群走你的 Agent。",
	"rules.mode.contains": "包含",
	"rules.mode.exact": "精确",
	"rules.matchPlaceholder": "群名关键字，例如 对接",
	"rules.agentPlaceholder": "选择 Agent",
	"sessions.title": "监听群现状",
	"sessions.desc": "「当前」是该群会话实际在跑的 Agent 预设，「目标」是路由算出来的结果。只对还没聊过（空白）的会话生效；已有历史的会话 DSH 不允许换预设，会一直保持原样。",
	"sessions.col.group": "群名",
	"sessions.col.current": "当前",
	"sessions.col.wanted": "目标",
	"sessions.col.state": "状态",
	"sessions.empty": "还没有群会话。等该群收到第一条消息、或微信助手启动时同步一次，这里就会出现。",
	"sessions.error": "读取会话失败：{msg}",
	"sessions.unknownGroup": "(不在监听列表)",
	"sessions.notSet": "(未指定)",
	"status.aligned": "一致",
	"status.pending": "待应用",
	"status.locked": "已有历史",
	"status.running": "处理中",
	"presets.error": "读取 Agent 预设名单失败：{msg}",
	"presets.broken": "该预设无法挂载：{reason}",
	"presets.default": "默认",
	"notify.reconcileApplied": "已应用 {n} 个空白会话。",
	"notify.reconcileSkipped": "跳过 {n} 个（已有历史或正在处理）。",
	"notify.reconcileFailed": "失败 {n} 个：{detail}",
	"notify.reconcileNone": "没有需要补正的空白会话。",
	"notify.notWrapped": "包装未生效：本插件没能接管 sessions.create，路由不会起作用。",
	"hint.settingsPath": "配置文件：{path}（本插件的段为 wechat-agent-router）",
	"hint.restart": "改动对新会话即时生效，无需重启；已经在跑的会话不受影响。"
};
const LOCALES = {
	zh,
	en: {
		"section.title": "WeChat routing",
		"section.desc": "Choose which agent preset a group session runs, based on the group name. Only that one value is touched — listening, sending, archiving, quote/image parsing, queues and retries stay entirely with the WeChat assistant plugin; this plugin changes none of its code.",
		"action.refresh": "Refresh",
		"action.save": "Save",
		"action.saving": "Saving…",
		"action.reconcile": "Apply now",
		"action.reconciling": "Applying…",
		"action.addRule": "Add rule",
		"action.remove": "Remove",
		"action.up": "Move up",
		"action.down": "Move down",
		"state.loading": "Loading…",
		"state.loadFailed": "Load failed: {msg}",
		"state.saved": "Saved",
		"state.saveFailed": "Save failed: {msg}",
		"state.unsaved": "Unsaved changes",
		"switch.enabled": "Enable group-name routing",
		"switch.enabledDesc": "When off, nothing is touched and group sessions keep the agent preset the WeChat assistant named.",
		"fallback.label": "Fallback agent",
		"fallback.desc": "Used when no rule matches. Pick \"leave as is\" to keep the current behaviour.",
		"fallback.none": "Leave as is (WeChat assistant default)",
		"rules.title": "Routing rules",
		"rules.desc": "Evaluated top-down; the first match wins. Match the group name exactly or by substring, then send that group to the chosen agent.",
		"rules.empty": "No rules yet. Add one to route matching groups to your agent.",
		"rules.mode.contains": "contains",
		"rules.mode.exact": "exact",
		"rules.matchPlaceholder": "group name keyword, e.g. 对接",
		"rules.agentPlaceholder": "pick an agent",
		"sessions.title": "Watched groups",
		"sessions.desc": "\"Current\" is the preset that group session actually runs; \"target\" is what routing resolves to. Only blank sessions (no turn yet) can switch — DSH refuses to change a preset once a conversation has history, so those stay as they are.",
		"sessions.col.group": "Group",
		"sessions.col.current": "Current",
		"sessions.col.wanted": "Target",
		"sessions.col.state": "State",
		"sessions.empty": "No group sessions yet. They appear after a group receives its first message, or after the WeChat assistant syncs on startup.",
		"sessions.error": "Could not read sessions: {msg}",
		"sessions.unknownGroup": "(not in the watch list)",
		"sessions.notSet": "(unset)",
		"status.aligned": "aligned",
		"status.pending": "pending",
		"status.locked": "has history",
		"status.running": "running",
		"presets.error": "Could not read the preset roster: {msg}",
		"presets.broken": "This preset cannot be mounted: {reason}",
		"presets.default": "default",
		"notify.reconcileApplied": "Applied to {n} blank session(s).",
		"notify.reconcileSkipped": "Skipped {n} (history or busy).",
		"notify.reconcileFailed": "Failed {n}: {detail}",
		"notify.reconcileNone": "No blank session needed fixing.",
		"notify.notWrapped": "Wrapping is inactive: this plugin could not take over sessions.create, so routing has no effect.",
		"hint.settingsPath": "Config file: {path} (this plugin's section is wechat-agent-router)",
		"hint.restart": "Changes apply to new sessions immediately, no restart needed; running sessions are untouched."
	}
};
/** 取词函数：按当前语言取，缺失回退中文，再回退键名。 */
function makeT(dict, fallback = zh) {
	return (key, vars) => {
		const template = (dict !== void 0 ? dict[key] : void 0) ?? fallback[key] ?? key;
		if (vars === void 0) return template;
		return template.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name] ?? ""));
	};
}
//#endregion
//#region src/styles.ts
const STYLE_ID = "dsh-wechat-agent-router-style";
const css = `
.wr-page{display:grid;gap:14px;padding:2px 0}
.wr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.wr-title{margin:0;font-size:15px;font-weight:600}
.wr-desc{margin:5px 0 0;font-size:12.5px;line-height:1.65;color:var(--color-text-secondary,#68707b);max-width:760px}
.wr-actions{display:flex;gap:8px;flex-wrap:wrap}
.wr-button{border:1px solid var(--color-border,#cfd4dc);border-radius:8px;background:transparent;color:inherit;min-height:32px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.wr-button:hover{border-color:var(--dsw-alias-border-l4,#94a3b8)}
.wr-button[data-primary=true]{background:var(--color-primary,#356ae6);border-color:transparent;color:#fff}
.wr-button:disabled{opacity:.5;cursor:not-allowed}
.wr-notice{border-left:3px solid #d97706;padding:9px 11px;background:rgba(217,119,6,.08);font-size:12.5px;line-height:1.6;border-radius:0 8px 8px 0;overflow-wrap:anywhere}
.wr-error{border-left:3px solid #d93c3c;padding:9px 11px;background:rgba(217,60,60,.08);font-size:12.5px;line-height:1.6;border-radius:0 8px 8px 0;overflow-wrap:anywhere}
.wr-ok{border-left:3px solid #15803d;padding:9px 11px;background:rgba(21,128,61,.08);font-size:12.5px;line-height:1.6;border-radius:0 8px 8px 0;overflow-wrap:anywhere}
.wr-panel{border:1px solid var(--color-border,#dfe2e7);border-radius:12px;padding:14px;display:grid;gap:11px;background:color-mix(in srgb,currentColor 3%,transparent)}
.wr-panel-title{margin:0;font-size:13.5px;font-weight:600}
.wr-field{display:grid;gap:6px}
.wr-label{font-size:13px;font-weight:600}
.wr-help{font-size:12px;line-height:1.6;color:var(--color-text-secondary,#68707b)}
.wr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wr-input,.wr-select{box-sizing:border-box;min-height:32px;border:1px solid var(--color-border,#cfd4dc);border-radius:8px;background:var(--color-background,#fff);color:inherit;padding:5px 9px;font:inherit;font-size:12.5px}
.wr-input{flex:1 1 200px;min-width:130px}
.wr-select{flex:0 0 auto;max-width:260px}
.wr-rule{border:1px solid var(--color-border,#e5e7eb);border-radius:10px;padding:9px;display:grid;gap:7px}
.wr-rule-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wr-arrow{font-size:12px;color:var(--color-text-secondary,#68707b)}
.wr-muted{font-size:12px;color:var(--color-text-secondary,#68707b)}
.wr-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere}
.wr-badge{font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;border:1px solid var(--color-border,#dfe2e7);opacity:.85;white-space:nowrap}
.wr-badge[data-tone=ok]{border-color:rgba(21,128,61,.5);color:#15803d}
.wr-badge[data-tone=warn]{border-color:rgba(217,119,6,.55);color:#b45309}
.wr-badge[data-tone=danger]{border-color:rgba(217,60,60,.55);color:#d93c3c}
.wr-badge[data-tone=info]{border-color:rgba(53,106,230,.45);color:var(--dsw-alias-brand-primary,#2b7cd9)}
.wr-table{border:1px solid var(--color-border,#e5e7eb);border-radius:10px;max-height:320px;overflow:auto}
.wr-tr{display:grid;grid-template-columns:minmax(160px,1.4fr) minmax(120px,1fr) minmax(120px,1fr) 92px;gap:8px;padding:7px 10px;border-bottom:1px solid var(--color-border,#eef0f3);align-items:center;font-size:12.5px}
.wr-tr:last-child{border-bottom:0}
.wr-tr[data-head=true]{position:sticky;top:0;background:var(--color-background,#fff);font-weight:600;font-size:12px;z-index:1}
.wr-switch-row{display:flex;align-items:flex-start;gap:12px;justify-content:space-between}
.wr-switch-text{display:grid;gap:3px;min-width:0}
.wr-switch-name{font-size:13px;font-weight:600}
.wr-switch-desc{font-size:12px;line-height:1.6;color:var(--color-text-secondary,#68707b)}
.wr-switch{border:1px solid var(--dsw-alias-border-l3,#cbd5e1);background:var(--dsw-alias-bg-layer-3,#e2e8f0);cursor:pointer;border-radius:999px;flex:none;align-items:center;width:40px;height:22px;padding:2px;display:inline-flex;transition:background .12s,border-color .12s}
.wr-switch[aria-checked=true]{border-color:var(--dsw-alias-brand-primary,#2b7cd9);background:var(--dsw-alias-brand-primary,#2b7cd9)}
.wr-switch-thumb{background:var(--dsw-alias-label-primary-foreground,#fff);width:18px;height:18px;box-shadow:0 0 0 1px var(--dsw-alias-border-l4,#0f172a1f);border-radius:50%;display:block;transition:transform .12s}
.wr-switch[aria-checked=true] .wr-switch-thumb{transform:translate(18px)}
`;
//#endregion
//#region src/client.tsx
const name = "dsh-wechat-agent-router-client";
const inject = ["slots"];
const NS = "wechat-agent-router";
const SECTION_LABEL = "微信路由";
const interpolate = (template, vars) => vars === void 0 ? template : template.replace(/\{(\w+)\}/g, (_match, key) => String(vars[key] ?? ""));
/** slot 渲染器会按注册时的 locale 命名空间给我们 t；取不到就退回中文词典。 */
function makeSectionT(props) {
	const fallback = makeT(zh);
	return (key, vars) => {
		const raw = typeof props?.t === "function" ? props.t(key) : fallback(key);
		return interpolate(typeof raw === "string" ? raw : String(raw), vars);
	};
}
function apply(ctx) {
	ctx.effect(() => {
		if (document.getElementById("dsh-wechat-agent-router-style") === null) {
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = css;
			document.head.appendChild(style);
		}
		return () => document.getElementById(STYLE_ID)?.remove();
	}, "wechat-agent-router 样式");
	const locale = typeof ctx.get === "function" ? ctx.get("locale") : void 0;
	if (locale !== void 0 && locale !== null && typeof locale.register === "function") locale.register(NS, LOCALES);
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: NS,
		order: 141,
		label: SECTION_LABEL,
		locale: NS
	}, (props) => /* @__PURE__ */ react.default.createElement(RouterSection, { t: makeSectionT(props) })));
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;

    return module.exports;
  }
});
