# TokenSlim - SillyTavern 聊天记录省 Token 插件

通过 **FCC（冻结压缩典籍）** 技术压缩聊天记录，实现 Token 节省 + 缓存命中率优化。

## 功能

- 🗜️ **17 种压缩策略可选**：精简列表 / PList / EAV / 渐进摘要 / 叙事折叠 / 原型锚点 / 情感栈 / 关系图谱 等
- 🧊 **冻结压缩典籍(FCC)**：生成的压缩摘要作为稳定前缀注入 prompt，内容冻结不变化
- ⚡ **手动 / 自动双触发**：随时点"生成 FCC"，或设置"自动压缩阈值"后每隔 N 轮自动压缩
- 🕳️ **增量补丁**：只压缩新增消息，append-only 追加，不破坏前缀缓存
- 🙈 **自动隐藏**：被压缩的聊天消息自动隐藏（is_system），不出现在 prompt 中，保留最近 N 条原文
- 💾 **缓存命中率优化**：三厂商策略路由（Anthropic/OpenAI/DeepSeek）+ 缓存杀手检测
- ✅ **Feynman 自检**：压缩质量保证，检测关键信息遗漏

## 安装

在 SillyTavern 扩展面板中粘贴此仓库链接，并填写分支名：

```
仓库 URL：https://github.com/woodmeone/tokenslim.git
分支：feature/tokenslim-mvp
```

点击 "Install Extension" 即可（SillyTavern 会用 `git clone -b feature/tokenslim-mvp` 安装）。

本地开发也可以直接复制 `tokenslim/` 目录到
`SillyTavern/public/scripts/extensions/third-party/` 下（注意：手动复制方式下
启动时的 auto-update 会报 "not a Git repository" 错误，不影响功能；用上面的
git 安装方式则无此问题）。

## 使用

1. 加载角色卡，开始聊天
2. 在扩展设置面板找到 "TokenSlim"
3. 点击 "⚡ 生成 FCC" —— 压缩当前聊天记录并注入 prompt
4. 之后聊天中新增消息累积到阈值，自动生成增量补丁（也可随时手动重建）

## 配置

| 选项 | 说明 | 默认 |
|------|------|------|
| 压缩策略 | 17 种格式，不确定选"渐进摘要（推荐）" | progressive |
| 目标 token 数 | 压缩后的大致 token 量（≥1024 更利于缓存命中） | 300 |
| 保留最近原文条数 | 压缩后保留最近 N 条消息原文不隐藏（0=全部压缩隐藏） | 2 |
| 自动压缩阈值 | 未压缩新消息累积 N 条时自动触发增量压缩 | 3 |
| 质量自检 | Feynman 自检，检查关键信息遗漏 | 开 |
| 自动注入 | 自动把压缩摘要注入 prompt | 开 |

## 技术原理

- **FCC** 存储在全局设置的 `extension_settings.tokenslim.charData[角色]`，按角色隔离
- 注入位置：`IN_CHAT`（position=1），depth=9999 —— 世界书之后、聊天记录之前，属于稳定前缀区
- 压缩摘要 + 增量补丁按压缩顺序拼接注入，作为前缀的一部分 → 每次请求前缀不变 → API 缓存命中 → 计费打折
- 补丁采用 append-only，不修改冻结部分；可"折叠补丁"合并回主体
- 隐藏使用 `hideChatMessageRange`（is_system=true），prompt 构建时被过滤

## 作者

比特毯子

## License

MIT
