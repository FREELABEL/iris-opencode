<p align="center">
  <a href="https://heyiris.io">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="IRIS Code logo">
    </picture>
  </a>
</p>
<p align="center"><strong>IRIS Code</strong> - AI-powered coding agent for the IRIS platform.</p>
<p align="center">
  <a href="https://github.com/FREELABEL/iris-opencode"><img alt="GitHub" src="https://img.shields.io/badge/github-FREELABEL/iris--opencode-blue?style=flat-square" /></a>
</p>

[![IRIS Code Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://heyiris.io)

---

### Installation

```bash
# One-line install (recommended)
curl -fsSL https://raw.githubusercontent.com/FREELABEL/iris-opencode/main/install | bash

# Or as part of the full IRIS SDK
curl -fsSL https://heyiris.io/install-iris.sh | bash
```

> [!NOTE]
> IRIS Code is a customized fork of [OpenCode](https://github.com/anomalyco/opencode), optimized for the IRIS platform.

### What is IRIS Code?

IRIS Code is an AI-powered coding assistant that runs in your terminal. It can:
- Read, write, and execute code autonomously
- Work with multiple AI providers (Claude, GPT, local models)
- Integrate seamlessly with the IRIS SDK and platform

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$IRIS_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if exists or can be created)
4. `$HOME/.iris/bin` - Default fallback

```bash
# Examples
IRIS_INSTALL_DIR=/usr/local/bin curl -fsSL https://heyiris.io/install-code | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://heyiris.io/install-code | bash
```

### Agents

IRIS Code includes two built-in agents you can switch between,
you can switch between these using the `Tab` key.

- **build** - Default, full access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also, included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://heyiris.io/docs/agents).

### Documentation

For more info on how to configure IRIS Code [**head over to our docs**](https://heyiris.io/docs).

### Contributing

If you're interested in contributing to IRIS Code, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. IRIS Code can be used with Claude, OpenAI, Google or even local models. As models evolve the gaps between them will close and pricing will drop so being provider-agnostic is important.
- Out of the box LSP support
- A focus on TUI. We are going to push the limits of what's possible in the terminal.
- A client/server architecture. This for example can allow IRIS Code to run on your computer, while you can drive it remotely from a mobile app. Meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/heyiris) | [X.com](https://x.com/heyiris)
