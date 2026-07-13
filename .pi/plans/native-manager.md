# Native manager plan

Move the extension’s canonical player state and all native integrations into `native-host.ts`. The extension becomes a thin YouTube Music adapter: it extracts a complete player snapshot, sends it to the local manager, renders the manager’s current state in the visualizer, and relays visualizer controls back into the YTM page.

This is deliberately a personal, native-required setup. `native-host.ts` must be running for the visualizer, arRPC, and Last.fm integration to work.

## Why this shape

Today the extension background worker merges separate metadata and playback updates, broadcasts state to the visualizer, and forwards a reduced version of that state to the native host. The host then normalizes it again before producing an arRPC activity. Adding Last.fm there would introduce a third independent interpretation of track lifecycle.

The native manager should instead own one canonical `PlayerSnapshot`. It stores the latest snapshot, serves it to every consumer, derives arRPC activity, and tracks Last.fm submission state. The content scripts only know how to obtain state from YouTube Music, while the visualizer only knows how to display and control it.

## Target topology

```text
YTM main-world script
  └─ window.postMessage
       └─ isolated content script
            └─ control WebSocket :32145 (role: player)
                 └─ native-host.ts
                      ├─ canonical PlayerSnapshot
                      ├─ visualizer WebSocket clients (role: visualizer)
                      ├─ arRPC-compatible WebSocket :1337
                      └─ Last.fm client

Visualizer
  └─ control WebSocket :32145 (role: visualizer)
       └─ command / seek messages
            └─ native host routes to current player publisher
                 └─ isolated script → window.postMessage → YTM main-world script
```

The arRPC endpoint stays separate because Vencord expects its existing wire format. The control endpoint is an extension-specific protocol shared by the player publisher and visualizer.

## Canonical state and control protocol

Define shared protocol types in a new extension/host-compatible TypeScript module, for example `shared/protocol.ts`. Avoid serializing two independently evolving `MediaState` types from the background and visualizer.

```ts
type PlayerSnapshot = {
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  lyrics: LyricsPayload | null;
  playing: boolean;
  durationMicros: number;
  elapsedTimeMicros: number;
  timestampEpochMicros: number;
  playbackRate: number;
};

type ClientMessage =
  | { type: 'HELLO'; role: 'player' | 'visualizer'; clientId: string }
  | { type: 'PLAYER_SNAPSHOT'; payload: PlayerSnapshot }
  | { type: 'COMMAND'; command: CommandSymbol }
  | { type: 'SEEK'; position: number };

type ServerMessage =
  | { type: 'STATE_UPDATE'; payload: PlayerSnapshot | null }
  | { type: 'COMMAND'; command: CommandSymbol }
  | { type: 'SEEK'; position: number }
  | { type: 'ERROR'; message: string };
```

The exact field naming can remain compatible with the visualizer to minimize UI changes. A snapshot is emitted only after the producer has both metadata and player state; sending a full snapshot prevents the native host from having to reconstruct data from partial events.

`HELLO` identifies the socket role. The manager keeps the latest player socket as the active publisher. For this personal setup, the active publisher is the most recently updated connected player that reports `playing: true`; it falls back to the most recently updated player when all are paused. This makes a background YTM tab capable of taking over, but avoids adding tab-management machinery now.

On visualizer connect, the manager immediately sends `STATE_UPDATE` with its stored snapshot. Commands from any visualizer are forwarded only to the active player. If none exists, the manager returns an error or ignores the command.

## Native manager changes

Refactor `native-host.ts` around a `PlayerManager` / `PlayerStateStore` instead of around arRPC activity messages:

1. Track connected control clients by role and retain the active player socket plus the latest `PlayerSnapshot`.
2. Validate incoming messages at the protocol boundary. Invalid JSON, unknown message types, and messages sent by the wrong role should be rejected without affecting the current state.
3. On `PLAYER_SNAPSHOT`, update the canonical state, select the publisher when appropriate, broadcast `STATE_UPDATE` to visualizer clients, update arRPC, and pass the snapshot to Last.fm.
4. Generate arRPC activity from the canonical snapshot. Preserve the current timestamp behavior: derive activity start/end from `timestampEpochMicros - elapsedTimeMicros` and duration, and avoid resending materially identical activities.
5. Route `COMMAND` and `SEEK` from visualizer clients to the active player socket. The host should not understand YTM DOM details.
6. Clear the current state, visualizer state, and arRPC activity when the active publisher disconnects. If another player publisher exists, select it and publish its last known snapshot instead.
7. Replace the current stale-activity timeout with a stale-player timeout that clears canonical state only when no fresh snapshot arrives from the active player. The producer cadence is currently about 1.5 seconds.

Keep the control server on loopback only. This is a personal tool, so localhost processes are treated as trusted; do not add tokens or a configuration UI unless that assumption changes.

## Content-script changes

Keep the existing two-world split because YTM metadata interception must run in the page’s main world while extension APIs and WebSocket permissions belong in the isolated world.

1. In `entrypoints/ytm-main.content.ts`, keep `currentMetadata` and the latest player-state payload together and emit a full `PLAYER_SNAPSHOT` whenever either meaningful value changes. Do not expose Last.fm or native-manager concerns here.
2. In `entrypoints/ytm-isolated.content.ts`, replace `browser.runtime.sendMessage` with a reconnecting WebSocket client to `ws://127.0.0.1:32145`.
3. Send `HELLO` with role `player` after every successful connection, then immediately resend the last snapshot so a restarted host recovers without waiting for a YTM event.
4. Receive forwarded `COMMAND` and `SEEK` messages from the host and retain the existing `window.postMessage` bridge into the main-world script.
5. Remove the noisy console logging while touching this code, but keep actionable connection errors concise.

Update `wxt.config.ts` to preserve the loopback WebSocket host permission. No Last.fm network permission is needed in the extension because only the native manager calls Last.fm.

## Visualizer changes

Refactor `entrypoints/visualizer/useSongState.ts` so it connects directly to the control WebSocket rather than `browser.runtime.connect`:

1. Connect, send `HELLO` with role `visualizer`, and update React state from `STATE_UPDATE`.
2. Reconnect on close with a modest backoff. The host sends the stored state upon reconnection, so the UI does not need a separate state recovery mechanism.
3. Send `COMMAND` and `SEEK` through the socket, retaining the existing control behavior and UI.
4. Treat a disconnected manager as unavailable controls/state rather than trying to fall back to extension-local data.

This removes background-worker dependency from the visualizer and lets it run as a client of the same canonical state source as arRPC and Last.fm.

## Background-worker changes

Shrink `entrypoints/background.ts` to the browser-action behavior that opens `visualizer.html`. Remove:

- media-state types and partial-state merging;
- content-script message handling;
- visualizer `Runtime.Port` handling;
- tab lifecycle tracking;
- native-host socket connection, reconnect logic, and RPC status messages.

A tiny background worker is still worthwhile for the toolbar action. Do not retain it as a duplicate state transport.

## Last.fm integration

Implement Last.fm in the native manager after the canonical state transport is working.

### Configuration and authentication

- Add a gitignored local native configuration file containing `apiKey`, `apiSecret`, and `sessionKey`, with a committed example file that documents the required exports.
- Add a one-shot Node setup script that performs Last.fm’s desktop authorization flow: request a signed `auth.getToken`, print/open the authorization URL, wait for approval, then exchange the token for a session key with signed `auth.getSession`.
- Keep the Last.fm secret and session key exclusively in the native process. Node’s `crypto.createHash('md5')` supplies the MD5 API signatures, so no runtime dependency is needed.

### Submission behavior

- Submit a signed, form-encoded `track.updateNowPlaying` POST as soon as a new track becomes playing.
- Submit `track.scrobble` exactly once when a track is longer than 30 seconds and its reported position reaches `min(duration / 2, 240 seconds)`.
- Send artist, track, optional album, duration in seconds, and the original Unix playback-start time derived from the snapshot timestamp minus elapsed position.
- Track lifecycle in memory, keyed by title, artist, and album. Clear it when the canonical track changes or state is cleared.
- Log request failures, but omit retry queues, batch submission, persistent deduplication, and an options UI. This matches the personal-tool simplicity goal.

This intentionally trusts YouTube Music’s elapsed position. Seeking forward can qualify a scrobble early, and immediately replaying an identical track without a metadata transition may not create a second submission. Fixing either requires more playback accounting and a stable YTM track identifier.

## Delivery order

1. Introduce shared protocol types and make the native manager retain/broadcast canonical snapshots while preserving current arRPC behavior.
2. Move the isolated content script from background messages to the control WebSocket, including snapshot resends and command routing.
3. Move the visualizer from `browser.runtime.Port` to the control WebSocket.
4. Reduce the background worker to the toolbar action and remove obsolete state transport.
5. Add local Last.fm configuration, the one-shot auth script, and the manager-side scrobbler.
6. Update the README with native-host startup, arRPC endpoint, and Last.fm setup instructions.

## Validation

- With the host running, open YTM and verify the visualizer receives title, artwork, lyrics, progress, pause state, and control commands.
- Restart the visualizer and verify it receives current state immediately without changing tracks.
- Restart the native host and verify the content script reconnects and republishes its snapshot.
- Disconnect the active YTM publisher and verify the visualizer and arRPC activity clear or switch to another active publisher.
- Connect Vencord to port 1337 and verify it receives the unchanged arRPC activity shape.
- Start a normal track and verify Last.fm now-playing updates immediately; verify one scrobble after the threshold, none for skipped or <=30-second tracks.
- Run `pnpm compile` and `pnpm build` after each transport milestone.

## References

- Last.fm desktop auth: <https://www.last.fm/api/desktopauth>
- Last.fm scrobbling rules: <https://www.last.fm/api/scrobbling>
- `track.updateNowPlaying`: <https://www.last.fm/api/show/track.updateNowPlaying>
- `track.scrobble`: <https://www.last.fm/api/show/track.scrobble>
