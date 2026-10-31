# dsh-message-queue

简体中文 | [English](README.en.md)

为 DeepSeek Harness 的待发消息队列提供拖动排序与暂停/恢复。

插件把内置的队列 dock 换成面板：可以拖拽（也可以用键盘）调整待发轮次的顺序，保留原有的
编辑、删除、「立即发送」（steer）操作，并支持暂停队列——当前轮次结束后，下一条待发消息
继续留在队列里，直到你恢复。

## 安装

```bash
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile <profile> add link:"$PWD"
```

`dsh plugin` 会把包写入 profile。先构建：宿主加载 `lib/index.js`，浏览器模块加载器加载
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

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 挂载队列控制器；浏览器面板才有实时队列可交互。 |

## 功能

- **排序。** 宿主服务提供 `messageQueue.move`，它通过 Agent 收件箱的 splice 事件写入新的
  `next-turn` 顺序。顺序是持久的，刷新页面后保留，并对所有已连接的客户端一致。
- **暂停/恢复。** 行上的按钮暂停单条消息，头部按钮暂停整个队列。队列级暂停会暂存所有排队
  项，期间新提交的消息也一并暂存。恢复队列只恢复被队列级暂停暂存的项；你自己暂停的行保持
  暂停。队列暂停期间恢复某一行，会立即发送那一条，随后暂停重新生效。
- **原有操作。** 编辑、删除和 steer 继续走会话自身的 `updateQueue` RPC，语义与附件处理都
  保持内置行为。
- **面板。** 插件以更低的优先级注册与内置 dock 相同的槽位单元
  （`conversation.input.dock`，id `queue`），因此它替代内置队列条渲染，插件停用时让位。

- **撤回最近的发送。** 面板列出队列最近 15 秒内发出的消息（最多五条），每条附带剩余
  时间。撤回其中一条会把它正文放回队首；模型还没看到的消息原样返回，模型已经看到的消息
  会获得一条模型可见的替代内容，说明用户撤回了它，聊天记录保留原文。

## 限制

- 面板覆盖主对话视图。子代理路由拥有的会话里，面板以只读方式渲染；宿主服务本身对任何
  活动 Agent 都可用。
- 被暂停暂存的项保存在宿主内存里。宿主重启会丢失暂停标记和暂存的一批；插件正常卸载时会
  把这一批写回收件箱。
- 队列暂停期间，被暂存的行仍可交互：拖动、用 ↑ / ↓ 按钮上下移动、编辑文本、删除，或用
  发送按钮把其中一条送进正在运行的轮次。暂停本身仍会挡住下一条自动轮次。
- 拖动跟随指针：每一帧平移该行，列表其余部分同时收拢空位；松手时只提交一次最终下标。
- 行只在所属分组内排序：先是被暂存的行，然后才是排队行。
- dock 默认展开；只有一条排队项时也像其他列表一样可以收起。
- 面板不列出 steer 输入（`next-step`）。
- 撤回覆盖最近 15 秒内发出的消息，最多五条。消息被领取到送达模型之间的窗口很短，因此
  这一分支属于尽力而为。
- 暂停状态按会话写入，并在挂载时、窗口获得焦点时以及暂停期间每隔几秒刷新；两个浏览器
  标签页最终以宿主的答案为准。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc -p tsconfig.test.json
pnpm lint        # oxlint src tests scripts
pnpm test        # vitest run
pnpm build       # tsc, then tsdown for the browser half, then the loader wrapper
pnpm check       # typecheck + lint + test
```

浏览器 bundle 由 `scripts/build-client.mjs` 包进
`window.__ModuleLoader__.load({ id, factory })`；其中 `id` 是包名。

改动 Typert 清单（新增或改名一个 invocation）后，重启宿主进程。typert 加载器在整个进程
生命周期内缓存每个包导入的清单，所以只重新加载插件，会让新的浏览器 bundle 配上旧的宿主
清单。

## 许可证

MIT
