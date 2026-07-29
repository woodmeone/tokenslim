# TokenSlim - SillyTavern 角色卡省 Token 插件

通过 **FCC（冻结压缩典籍）** 技术压缩角色卡文本，实现 Token 节省 + 缓存命中率优化。

## 功能

- 🗜️ **5轮压缩管线**：删废话 → 类型化 → 结构化(PList) → 原型锚点 → 一句话总结
- 🧊 **冻结压缩典籍(FCC)**：生成稳定的压缩内容，作为 prompt 前缀
- 💾 **缓存命中率优化**：三厂商策略路由（Anthropic/OpenAI/DeepSeek）
- 🔍 **缓存杀手检测**：5条规则只读检测，健康度评分
- 📝 **增量补丁**：append-only 更新，不破坏前缀缓存
- ✅ **Feynman自检**：压缩质量保证，检测关键信息遗漏

## 安装

在 SillyTavern 扩展面板中粘贴此仓库链接：

```
https://github.com/woodmeone/tokenslim
```

点击 "Install Extension" 即可。

## 使用

1. 加载角色卡
2. 在扩展设置面板找到 "TokenSlim"
3. 点击 "⚡ 生成 FCC"
4. 插件自动注入压缩后的角色信息到 prompt

## 配置

| 选项 | 说明 |
|------|------|
| 格式 | PList（推荐）/ 精简列表 / W+ / W++ |
| Token 目标 | 压缩后目标 token 数（默认 150） |
| 原型锚点 | 识别文化原型，只保留偏离设定 |
| Feynman 自检 | 检查压缩是否遗漏关键信息 |
| 自动注入 | 角色卡加载时自动注入 FCC |

## 技术原理

- **FCC** 存储在角色卡 `extensions.tokenslim.fcc` 字段
- 注入位置：`before_char`（position=1）
- 补丁采用 append-only，不修改冻结部分
- 使用 `saveMetadataDebounced()` 保存角色卡数据

## 作者

比特毯子

## License

MIT