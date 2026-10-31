# dsh-message-queue

中文 | [English](README.en.md)

为 DeepSeek Harness 的待发消息队列提供拖动排序、按条/整体暂停与最近发送撤回。

插件替换内置队列条：可以拖动（或用键盘）调整待发顺序，保留原有的编辑、删除、立即发送，
并支持暂停——当前轮结束后不再自动发下一条，直到恢复为止。

## 安装

```bash
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile <profile> add link:"$PWD"
```

`dsh plugin` 把包写进 profile。链接前先构建：宿主加载 `lib/index.js`，浏览器模块加载
`lib/client.js`。

## 配置

`cordis.patch.yml` 把宿主条目插入 profile 组合树：

```yaml
- insert:
    - id: message-queue
      name: 'dsh-message-queue'
      config:
        enabled: true
```

| 配置项 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 挂载队列控制器；浏览器面板随之有可交互的队列。 |

## 功能

- **排序**：宿主服务通过 `messageQueue.move` 把新顺序写成 Agent 收件箱的 splice 事件，顺序
  持久化，刷新页面后保留，并对所有已连接的客户端一致。
- **暂停/恢复**：每行的按钮暂停这一条，面板头部按钮暂停整个队列。总暂停会暂存所有排队项，
  期间新提交也归入暂存；总恢复只恢复被总暂停暂存的项，手动暂停的保持暂停。总暂停期间恢复
  某一条会立即发送它，随后总暂停自动重新生效。
- **原有操作**：编辑、删除、立即发送继续走会话自身的 `updateQueue` RPC，语义与附件处理保持
  内置行为。
- **面板替换**：插件以更低的 priority 注册与内置队列条相同的槽位格位
  （`conversation.input.dock`，id `queue`），停用插件后内置队列条自动恢复。
- **最近发送撤回**：面板列出 15 秒内由队列发送的消息（最多 5 条），每条显示剩余时间。撤回
  会把正文放回队首；模型尚未看到的消息原样回队，模型已看到的消息会获得一条“用户已撤回”
  的模型可见替代内容，聊天记录保留原文。
- **折叠**：面板默认展开；只有一条待发消息时也可以收起。

## 限制

- 面板覆盖主会话视图。子代理路由拥有的会话里面板只读；宿主服务本身对任何活 Agent 可用。
- 暂停暂存的项保存在宿主内存。宿主重启会丢失暂停标记与暂存批次；插件正常卸载时会把批次写
  回收件箱。
- 暂停期间暂存行仍可操作：拖动、用 ↑ / ↓ 调整、编辑、删除，或在有运行轮次时用发送按钮送进
  当前轮。暂停本身仍会挡住下一次自动发送。
- 拖动跟随指针：被拖行每帧平移，其余行让位；松手时只提交一次最终下标。
- 行只在所属组内排序：暂存行在前，排队行在后。
- 插队输入（`next-step`）不在面板中列出。
- 撤回窗口为 15 秒、最多 5 条；从被领取到交给模型之间的窗口很短，这一分支是尽力而为。
- 暂停状态按会话保存，挂载、窗口聚焦与暂停期间每隔几秒刷新；两个标签页以宿主结果为准。

## 开发

```bash
pnpm install --ignore-workspace
pnpm typecheck   # tsc -p tsconfig.test.json
pnpm lint        # oxlint src tests scripts
pnpm test        # vitest run
pnpm build       # tsc，然后 tsdown 打包浏览器半边，最后包成 loader 单文件
pnpm check       # typecheck + lint + test
```

浏览器 bundle 由 `scripts/build-client.mjs` 包成
`window.__ModuleLoader__.load({ id, factory })`，`id` 就是包名。

修改 Typert 清单（新增或改名 invocation）后必须重启宿主进程：typert loader 会在进程内缓存
每个包已导入的清单，只重载插件会让新浏览器 bundle 遇到旧宿主清单。

## 许可证

MIT
