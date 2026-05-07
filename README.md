# Hermesian

Hermesian is an Obsidian desktop plugin that opens a local chat view for Hermes Agent.

The plugin connects to Hermes through the Agent Client Protocol (ACP) by launching `hermes acp` inside WSL. It does not depend on the Hermes Dashboard web token or the messaging gateway.

## Features

- Sidebar chat view with streaming Hermes responses.
- New session, cancel, and restart controls.
- Explicit context attachments for the current note or selected text.
- Tool-call rendering and inline permission approval.
- Settings for WSL distro, Hermes command, automatic ACP startup, approval timeout, and optional Dashboard launcher path.

## Development

```bash
npm install
npm test
npm run build
```

`npm run build` type-checks the plugin and writes the Obsidian-ready package to:

```text
release/hermesian/
```

For local Obsidian testing, copy or link `release/hermesian` to:

```text
<Vault>/.obsidian/plugins/hermesian/
```

Then reload Obsidian and enable **Hermesian** in **Settings -> Community plugins**.

## Release package

The release package contains:

- `main.js`
- `manifest.json`
- `styles.css`

Upload those files from `release/hermesian/` to a GitHub Release when publishing a version.

## License

Hermesian is released under the MIT License.
