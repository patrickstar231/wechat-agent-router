// 把 tsdown 产出的 CJS 浏览器半包成 DSH 的 window.__ModuleLoader__.load 形状。
// 与 agent-manager 的同款脚本一致，只换 id。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = readFileSync(resolve(root, '.tmp/client.cjs'), 'utf8')
const target = resolve(root, 'lib/client.js')
const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-wechat-agent-router",
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
${source}
    return module.exports;
  }
});
`

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, wrapped, 'utf8')
rmSync(resolve(root, '.tmp'), { recursive: true, force: true })
console.log('dsh-wechat-agent-router client bundle 已生成。')
