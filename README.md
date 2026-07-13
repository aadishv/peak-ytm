# peak ytm

A Chrome extension that gives YouTube Music a fullscreen lyrics visualizer, including translations normally exposed by the mobile client. A local native manager owns player state, routes visualizer controls, publishes Discord activity through an arRPC-compatible socket, and optionally submits tracks to Last.fm.

![demo](demo.jpg)

## Setup

Install dependencies and build the extension:

```sh
pnpm install
pnpm build
```

Load `.output/chrome-mv3` as an unpacked Chrome extension. Start the native manager before using YouTube Music or the visualizer:

```sh
pnpm native-host
```

The manager listens on loopback only:

- `ws://127.0.0.1:32145` is the extension control and state endpoint.
- `ws://127.0.0.1:1337` is the arRPC-compatible endpoint for Vencord.

The visualizer and content script reconnect automatically when the manager restarts. Click the extension toolbar action to open the visualizer.

## Last.fm

Create a Last.fm API application, copy `.env.example` to `.env.local`, and fill in `LASTFM_API_KEY` and `LASTFM_API_SECRET`. Then run the desktop authorization flow:

```sh
node native-host.ts auth
```

The command opens Last.fm's approval page and waits for confirmation. Once approved, it exchanges the token and writes `LASTFM_SESSION_KEY` into `.env.local` automatically. Start the native manager normally afterward; it will report that Last.fm integration is enabled. `.env.local` is gitignored because it contains the shared secret and session key.

Tracks longer than 30 seconds are scrobbled once their reported position reaches half the duration or four minutes, whichever comes first. Seeking can therefore satisfy the threshold early.
