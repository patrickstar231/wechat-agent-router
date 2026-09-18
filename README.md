# dsh-wechat-agent-router

按**微信群名**决定这条群会话用哪个 Agent 预设（DeepSeek Harness 插件）。只为了一件事：让配好提示词 / 知识库 / MCP 的 Agent 去接某些群的消息，其余全部复用 `dsh-wechat-assistant` 的逻辑。

## 安装

```sh
dsh plugin --profile web add dsh-wechat-agent-router
```

装完重启 `dsh web`，设置里会出现 **微信路由** 分区。

- **宿主要求**：`dsh` `0.1.0-rc.7`（见 `package.json` 的 `dsh.engines.dsh`）；Node `^22.19.0 || ^24.0.0`。
- **功能上依赖 `dsh-wechat-assistant`**：本插件不监听、不收发消息，它只干预「这个群的会话用哪个预设」。
  没装微信助手时插件能正常加载，但没有任何群可路由（面板里的群列表会是空的）。
- **客户端产物随包分发**（`lib/client.js` 已提交），安装时不需要构建。

## 它做什么（以及刻意不做什么）

| | |
| --- | --- |
| **做** | 群名（包含 / 精确）→ Agent 预设 id 的路由；配置界面；把"还没聊过但预设不对"的空白会话补正过来 |
| **不做** | 监听群、读消息、@判定、引用/图片解析、队列串行、按日归档、分片回复、心跳重启、模型选择与配额降级 —— 这些**全部**仍是 `dsh-wechat-assistant` 的代码，本插件**一行都不改**、也不复制 |

所以本插件只有 host 平面 + 一个设置分区，**没有任何 preset 平面**（它从不进入 Agent 组合，只在 host 干扰"会话用哪个预设"这一个值）。

## 零侵入是怎么做到的

`dsh-wechat-assistant` 在创建群会话时**点名**了一个预设：

```ts
// src/bridge.ts（同事的代码，未改动）
unwrap(await ctx.apiProxy.sessions.create(request({
  sessionId,
  workspaceId: workspace.workspaceId,
  agentPreset: 'wechat',
})))
```

本插件在 host 平面把 **`apiProxy.sessions.create` 这一个方法**包一层，按 `sessionId` 反查群名、算出目标预设、改写 `agentPreset` 后放行。依据（实测 `dsh-host-apiproxy/lib/index.js`）：

- 域是实例属性上的**普通对象**（`this.sessions = api.sessions`），方法可安全替换；
- `sessions.create` 的契约写明"同一 `sessionId` 重试返回同一个会话"（**幂等**），所以对已存在的会话改写参数不会产生副作用；
- `sessions.list()` 的条目带 `blank`（是否还没跑过 turn）与 `agentPreset`（当前实际在跑的），所以"该不该补正"是**精确判断**而不是猜；
- 群与会话是一一对应的**确定性**关系：`sessionId = 'wechat-group-' + sha256(群名).slice(0,32)`（`lib/router.js` 里复刻，并有回归测试锁住字面量）。

## 生效语义（重要）

- **只对"空白会话"生效**：DSH 规定 `agentPreset.select` 仅允许在会话还没跑过 turn 时使用，聊过之后会返回 `agent-preset-locked`（历史里的工具调用属于旧组合，换掉会让日志自相矛盾）。
- 因此本插件做两件事：① 包装 `sessions.create`，让**新会话**从一开始就用对的预设；② 启动后（以及每次保存配置后）扫一遍现有群会话，把 **`blank === true` 且预设不对**的**补正**过来。
- **已有历史的群会话不会被改动**，会一直保持原样（面板里显示「已有历史」）。这也是"只影响后续"的实现方式：不需要迁移历史，也不需要换 `sessionId`。
- 改配置**对新会话即时生效**，无需重启 DSH。

## 配置

写在 `~/.dsh/settings.yaml` 本插件自己的段里（不碰同事的 `wechat-assistant` 段，只**读**它的 `groups` 来知道有哪些群）：

```yaml
wechat-agent-router:
  enabled: true            # 关闭 = 完全不干预
  defaultAgent: ''         # 兜底；空串 = 不干预（沿用微信助手原本点名的 wechat）
  rules:                   # 自上而下，第一条命中者生效
    - match: 对接           # 群名关键字
      mode: contains       # contains（默认，不区分大小写）| exact
      agent: iot
    - match: 群聊总结
      mode: exact
      agent: archive-agent
```

界面入口：**设置 → 微信路由**（与「Agent 管理」并列）。面板里能看每个监听群**当前实际用的预设**与**路由算出的目标**，以及是否对得上。

## 已知限制

- **只能按群路由**：粒度是"群 = 一条会话 = 一个 Agent"，做不到"同一个群里按消息内容换 Agent"。
- **不支持私信**：`dsh-wechat-assistant` 的 Python 端只接受群聊目标（好友会话会直接报「监听目标不是群聊」），候选列表也只给群聊。要支持私信必须改它的传输层。
- **不接管模型**：桥接每条消息都会把模型强制 select 成全局 `modelProvider/modelName`，会覆盖 Agent 预设里的模型设置。想让模型也跟着路由走，需要额外处理。
- **依赖 `sessionId` 方案**：群名反查靠复刻的 `sha256('wechat-group-'+…)`。若上游改了算法，路由匹配不到群 → 自动退化为"不干预"（不会报错，但也不生效）；`tests/router.test.mjs` 用字面量锁住这个值就是为了尽早发现这种漂移。
- 包装失败（`apiProxy` 形状变了等）时**明确报告**而不是静默：日志里会有 `会话预设包装未安装：…`，面板顶部也会给出提示。

## 开发

```powershell
npm install          # 需要 devDependencies（tsdown / typescript / @types/*）
npm run build        # 产出 lib/client.js（已随仓库提交，运行时无需构建）
npm run typecheck
npm test             # node --test tests/*.test.mjs
```

host 半是免构建的 `lib/*.js`；只有浏览器半需要 tsdown 打包，再由 `scripts/wrap-client.ts` 包成
DSH 的 `window.__ModuleLoader__.load` 形状。`npm publish` 前 `prepack` 会自动跑一次构建。

## 上架（awesome-dsh-plugin / dsh-market）

插件市场里的列表来自精选列表仓库 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
收录方式是**往那边提 PR 新增一个条目文件**（不是往 dsh-market 提）：

1. fork 该仓库，把本仓库的 `contrib/let-mi-think__wechat-agent-router.yml` 复制成 `data/plugins/let-mi-think__wechat-agent-router.yml`（文件名必须与仓库一致）；
2. PR 前确认本仓库已声明 `dsh.bundle` 且根目录有 `cordis.patch.yml`（两个都已具备）；
3. 给 GitHub 仓库加 `dsh-plugin` topic，并确保仓库创建已满 1 天（CI 会检查）；
4. 提 PR（一个 PR 最多 3 条，且只改自己那一条）。合并后站点与市场的 README 会自动重建，**不要手工编辑那边的 README**。

npm 包不是收录的必要条件，但发了才能显示下载量：`npm publish` 后映射会被自动采集
（条目里**不要**写 `npm:` 键，写了会被校验拒绝）。本仓库的 `repository` 已指向自己，
`prepack` 会在发布前自动跑一次构建，`lib/` 也已随仓库提交，因此从 npm 安装无需构建。

## 许可

MIT
