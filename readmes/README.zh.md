<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">为终端构建的 AI 编程代理。</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/sst/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/sst/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

[![OpenCode 终端界面](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### 安装

```bash
# 一键安装
curl -fsSL https://opencode.ai/install | bash

# 包管理器
npm i -g opencode-ai@latest        # 或 bun/pnpm/yarn
scoop bucket add extras; scoop install extras/opencode  # Windows
choco install opencode             # Windows
brew install opencode      # macOS 和 Linux
paru -S opencode-bin               # Arch Linux
```

> [!TIP]
> 安装前请移除 0.1.x 之前的旧版本。

#### 安装目录

安装脚本按以下优先级顺序确定安装路径：

1. `$OPENCODE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 标准用户二进制目录（如果存在或可创建）
4. `$HOME/.opencode/bin` - 默认回退目录

```bash
# 示例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### 文档

有关如何配置 OpenCode 的更多信息，[**请查看我们的文档**](https://opencode.ai/docs)。

### 贡献

如果您有兴趣为 OpenCode 做出贡献，请在提交拉取请求之前阅读我们的[贡献文档](./CONTRIBUTING.md)。

### 常见问题

#### 这与 Claude Code 有什么不同？

在功能方面它与 Claude Code 非常相似。以下是主要区别：

- 100% 开源
- 不绑定任何提供商。虽然推荐使用 Anthropic，但 OpenCode 可以与 OpenAI、Google 甚至本地模型一起使用。随着模型的发展，它们之间的差距将缩小，价格将下降，因此提供商无关性很重要。
- 开箱即用的 LSP 支持
- 专注于 TUI。OpenCode 由 neovim 用户和 [terminal.shop](https://terminal.shop) 的创建者构建；我们将推动终端中可能性的极限。
- 客户端/服务器架构。例如，这可以让 OpenCode 在您的计算机上运行，而您可以从移动应用程序远程驱动它。这意味着 TUI 前端只是可能的客户端之一。

#### 另一个仓库是什么？

另一个令人困惑的同名仓库与此仓库无关。您可以[在这里阅读其背后的故事](https://x.com/thdxr/status/1933561254481666466)。

---

**加入我们的社区** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
