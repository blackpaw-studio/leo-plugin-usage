# Leo Usage

A [Leo](https://github.com/blackpaw-studio/leoterm) plugin that shows Claude Code and Codex usage for many accounts, in the Leo sidebar and command palette.

## Requirements

A Leo version that supports plugin `apiVersion` 2.

## Permissions

The install sheet lists three permissions.

- **`network`**: `api.anthropic.com` is where the plugin reads Claude usage, and `chatgpt.com` is where it reads Codex usage. It makes no other requests.
- **`secrets`**: the plugin's own Keychain item, holding its state: account order, labels and the last usage snapshot. No tokens are stored in it.
- **`credentials`**: Leo's app reads each account's token and attaches it only to requests to `api.anthropic.com` or `chatgpt.com`. The plugin never sees tokens, and nothing refreshes them.

When you add a Claude account, macOS asks once to let Leo read that account's Keychain item. Click **Always Allow**.

## Install

[Install in Leo](leo://plugin/install?url=https%3A%2F%2Fgithub.com%2Fblackpaw-studio%2Fleo-plugin-usage&ref=v0.1.0)

```
leo://plugin/install?url=https%3A%2F%2Fgithub.com%2Fblackpaw-studio%2Fleo-plugin-usage&ref=v0.1.0
```

## Development

```
npm ci
npm test
npm run build
```

`dist/main.js` is committed build output; CI fails if it is out of date. To try your changes, use **Load local folder…** in Leo's plugin settings and pick this directory.

`sdk/leo.d.ts` and `test/vendor/LeoPluginSymbolAllowlist.swift` are vendored from `blackpaw-studio/leoterm`; re-vendor rather than editing.
