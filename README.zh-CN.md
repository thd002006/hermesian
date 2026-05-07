# Hermesian

[English README](README.md)

Hermesian 是一个 Obsidian 桌面端插件，用于在 Obsidian 侧边栏中打开本地 Hermes Agent 聊天视图。

插件通过 Agent Client Protocol (ACP) 连接 Hermes：它会在 WSL 中启动 `hermes acp`。Hermesian 不依赖 Hermes Dashboard 的网页 token，也不依赖消息网关。

## 功能

- 在侧边栏中与 Hermes 进行流式聊天。
- 支持新建会话、取消当前回复、重启连接。
- 支持把当前笔记或选中文本作为显式上下文附件。
- 支持展示工具调用，并在界面内批准权限请求。
- 支持配置 WSL 发行版、Hermes 命令、自动启动 ACP、权限批准超时时间，以及可选的 Dashboard 启动脚本路径。

## 开发

```bash
npm install
npm test
npm run build
```

`npm run build` 会执行类型检查，并把 Obsidian 可安装的插件包输出到：

```text
release/hermesian/
```

本地测试时，可以把 `release/hermesian` 复制或链接到你的 Obsidian vault：

```text
<Vault>/.obsidian/plugins/hermesian/
```

然后重载 Obsidian，并在 **设置 -> 第三方插件** 中启用 **Hermesian**。

## 发布包

发布包包含：

- `main.js`
- `manifest.json`
- `styles.css`

发布新版本时，把 `release/hermesian/` 中的这些文件上传到 GitHub Release。

## 许可证

Hermesian 使用 MIT License 开源。
