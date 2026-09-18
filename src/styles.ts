// 本分区的样式（类名统一 wr- 前缀，避免与兄弟插件冲突）。
// 视觉沿用 agent-manager 的语言：细边框、12~13px 字号、等宽显示 id。
export const STYLE_ID = 'dsh-wechat-agent-router-style'

export const css = `
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
`
