# now playing

Tiny Bun web app that mirrors the Apple Music fullscreen now playing view.

It uses Bun's built-in HTML bundling, streams metadata over a WebSocket, and reads now playing state from `mediaremote-adapter` via the Homebrew `media-control` install.

## setup

```bash
brew tap ungive/media-control
brew install media-control
bun install
bun run src/server.ts
```

Then open <http://music.localhost:3000>.

## notes

- The server talks to the adapter directly via `/usr/bin/perl` and the assets bundled in `media-control`.
- By default it auto-discovers the Homebrew install with `brew --prefix media-control`.
- You can override paths with:
  - `MEDIAREMOTE_ADAPTER_SCRIPT`
  - `MEDIAREMOTE_ADAPTER_FRAMEWORK`
  - `MEDIAREMOTE_ADAPTER_HELPER`

## commands

```bash
bun run dev
bun run typecheck
```
