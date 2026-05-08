import { existsSync } from "node:fs";
import { Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import html from "../index.html";

const MediaStateSchema = Type.Object({
  title: Type.Optional(Type.String()),
  artist: Type.Optional(Type.String()),
  album: Type.Optional(Type.String()),
  uniqueIdentifier: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  contentItemIdentifier: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  artworkData: Type.Optional(Type.String()),
  artworkMimeType: Type.Optional(Type.String()),
  durationMicros: Type.Optional(Type.Number()),
  elapsedTimeMicros: Type.Optional(Type.Number()),
  playbackRate: Type.Optional(Type.Number()),
  plainLyrics: Type.Optional(Type.String()),
  syncedLyrics: Type.Optional(Type.String()),
  instrumental: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

type MediaState = Static<typeof MediaStateSchema> & Record<string, unknown>;
type ServerType = ReturnType<typeof Bun.serve<{ subscribed: boolean }>>;

const StreamDataMessageSchema = Type.Object({
  type: Type.Literal("data"),
  diff: Type.Boolean(),
  payload: MediaStateSchema,
}, { additionalProperties: true });

const StreamStatusMessageSchema = Type.Object({
  type: Type.Union([Type.Literal("ready"), Type.Literal("heartbeat")]),
}, { additionalProperties: true });

const StreamErrorMessageSchema = Type.Object({
  type: Type.Literal("error"),
  message: Type.Optional(Type.String()),
}, { additionalProperties: true });

const StreamMessageSchema = Type.Union([
  StreamDataMessageSchema,
  StreamStatusMessageSchema,
  StreamErrorMessageSchema,
]);

const LyricsResponseSchema = Type.Object({
  id: Type.Number(),
  trackName: Type.String(),
  artistName: Type.String(),
  albumName: Type.String(),
  duration: Type.Number(),
  instrumental: Type.Boolean(),
  plainLyrics: Type.Optional(Type.String()),
  syncedLyrics: Type.Optional(Type.String()),
}, { additionalProperties: true });

const ControlRequestSchema = Type.Object({
  command: Type.Union([
    Type.Literal("previous-track"),
    Type.Literal("toggle-play-pause"),
    Type.Literal("next-track"),
  ]),
}, { additionalProperties: true });

const SeekRequestSchema = Type.Object({
  positionSeconds: Type.Number({ minimum: 0 }),
}, { additionalProperties: true });

type StreamMessage = Static<typeof StreamMessageSchema>;
type GetCommandOutput = MediaState | null;

type AdapterPaths = {
  script: string;
  framework: string;
  helper: string | undefined;
  mediaControl: string;
};

type LyricsResponse = Static<typeof LyricsResponseSchema>;
type ControlRequest = Static<typeof ControlRequestSchema>;
type SeekRequest = Static<typeof SeekRequestSchema>;

const CONTROL_COMMANDS = ["previous-track", "toggle-play-pause", "next-track"] as const;

const decoder = new TextDecoder();

let currentState: MediaState | null = null;
let streamProcess: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
let stateMutationId = 0;

const runCommand = (cmd: string[]) => Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
const decode = (value: Uint8Array | Buffer<ArrayBufferLike>) => decoder.decode(value).trim();

async function resolveAdapterPaths(): Promise<AdapterPaths> {
  const script = process.env.MEDIAREMOTE_ADAPTER_SCRIPT;
  const framework = process.env.MEDIAREMOTE_ADAPTER_FRAMEWORK;

  if (script && framework) {
    return {
      script,
      framework,
      helper: process.env.MEDIAREMOTE_ADAPTER_HELPER,
      mediaControl: process.env.MEDIA_CONTROL_BIN ?? "/opt/homebrew/bin/media-control",
    };
  }

  const prefix = (() => {
    const result = runCommand(["brew", "--prefix", "media-control"]);
    return result.exitCode === 0 ? decode(result.stdout) : "/opt/homebrew/opt/media-control";
  })();

  const mediaControl = (() => {
    const result = runCommand(["which", "media-control"]);
    return result.exitCode === 0 ? decode(result.stdout) : `${prefix}/bin/media-control`;
  })();

  const paths: AdapterPaths = {
    script: `${prefix}/lib/media-control/mediaremote-adapter.pl`,
    framework: `${prefix}/Frameworks/MediaRemoteAdapter.framework`,
    helper: `${prefix}/lib/media-control/MediaRemoteAdapterTestClient`,
    mediaControl,
  };

  if (!existsSync(paths.script) || !existsSync(paths.framework) || !existsSync(paths.mediaControl)) {
    throw new Error(
      `Could not find media-control assets. Looked for script at ${paths.script}, framework at ${paths.framework}, and cli at ${paths.mediaControl}.`,
    );
  }

  return paths;
}

const adapterPaths = await resolveAdapterPaths();

function buildAdapterCommand(...args: string[]): string[] {
  return [
    "/usr/bin/perl",
    adapterPaths.script,
    adapterPaths.framework,
    ...(adapterPaths.helper ? [adapterPaths.helper] : []),
    ...args,
  ];
}

function parseWithSchema<T>(schema: Parameters<typeof Value.Decode>[0], value: unknown, message: string): T {
  if (!Value.Check(schema, value)) {
    throw new Error(message);
  }

  return Value.Decode(schema, value) as T;
}

function normalizeState(value: unknown): MediaState | null {
  const state = parseWithSchema<MediaState>(MediaStateSchema, value, "mediaremote-adapter returned invalid media state");
  if (Object.keys(state).length === 0) {
    return null;
  }

  return typeof state.title === "string" && state.title.length > 0 ? state : null;
}

function getTrackKey(state: MediaState | null): string {
  if (!state || typeof state.title !== "string" || state.title.length === 0) {
    return "";
  }

  return String(
    state.uniqueIdentifier
      ?? state.contentItemIdentifier
      ?? `${state.title}::${String(state.artist ?? "")}::${String(state.album ?? "")}`,
  );
}

async function fetchLyrics(state: MediaState): Promise<LyricsResponse | null> {
  if (
    typeof state.title !== "string"
    || typeof state.artist !== "string"
    || typeof state.album !== "string"
    || typeof state.durationMicros !== "number"
    || !Number.isFinite(state.durationMicros)
    || state.durationMicros <= 0
  ) {
    return null;
  }

  const params = new URLSearchParams({
    track_name: state.title,
    artist_name: state.artist,
    album_name: state.album,
    duration: String(Math.round(state.durationMicros / 1_000_000)),
  });

  const response = await fetch(`https://lrclib.net/api/get?${params}`, {
    signal: AbortSignal.timeout(5000),
    headers: {
      accept: "application/json",
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`LRCLIB lookup failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  return parseWithSchema<LyricsResponse>(LyricsResponseSchema, payload, "LRCLIB returned invalid JSON");
}

async function resolveSong(previous: MediaState | null, next: MediaState | null): Promise<MediaState | null> {
  if (!next) {
    return null;
  }

  const resolved: MediaState = { ...next };
  const isSameTrack = previous && getTrackKey(previous) === getTrackKey(next);

  if (isSameTrack && typeof resolved.artworkData !== "string" && typeof previous.artworkData === "string") {
    resolved.artworkData = previous.artworkData;
  }

  if (isSameTrack && typeof resolved.artworkMimeType !== "string" && typeof previous.artworkMimeType === "string") {
    resolved.artworkMimeType = previous.artworkMimeType;
  }

  if (isSameTrack && typeof resolved.plainLyrics !== "string" && typeof previous?.plainLyrics === "string") {
    resolved.plainLyrics = previous.plainLyrics;
  }

  if (isSameTrack && typeof resolved.syncedLyrics !== "string" && typeof previous?.syncedLyrics === "string") {
    resolved.syncedLyrics = previous.syncedLyrics;
  }

  if (isSameTrack && typeof resolved.instrumental !== "boolean" && typeof previous?.instrumental === "boolean") {
    resolved.instrumental = previous.instrumental;
  }

  if (isSameTrack && (typeof resolved.plainLyrics === "string" || typeof resolved.syncedLyrics === "string" || resolved.instrumental === true)) {
    return resolved;
  }

  try {
    const lyrics = await fetchLyrics(resolved);
    if (!lyrics) {
      return resolved;
    }

    if (typeof lyrics.plainLyrics === "string") {
      resolved.plainLyrics = lyrics.plainLyrics;
    }

    if (typeof lyrics.syncedLyrics === "string") {
      resolved.syncedLyrics = lyrics.syncedLyrics;
    }

    resolved.instrumental = lyrics.instrumental;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }

  return resolved;
}

async function mergeState(previous: MediaState | null, payload: MediaState, diff: boolean): Promise<MediaState | null> {
  if (!diff) {
    return resolveSong(previous, normalizeState(payload));
  }

  const next: MediaState = { ...(previous ?? {}) };

  for (const [key, value] of Object.entries(payload)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  return resolveSong(previous, normalizeState(next));
}

function broadcast(server: ServerType): void {
  server.publish("updates", JSON.stringify(currentState));
}

async function readJsonLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void | Promise<void>): Promise<void> {
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          await onLine(line);
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    const finalLine = (buffer + decoder.decode()).trim();
    if (finalLine) {
      await onLine(finalLine);
    }
  } finally {
    reader.releaseLock();
  }
}

function readStdout(result: ReturnType<typeof runCommand>): string {
  return decode(result.stdout);
}

function readStderr(result: ReturnType<typeof runCommand>): string {
  return decode(result.stderr);
}

function runOrThrow(cmd: string[], message: string): string {
  const result = runCommand(cmd);
  if (result.exitCode !== 0) {
    throw new Error(readStderr(result) || message);
  }
  return readStdout(result);
}

function parseGetCommandOutput(output: string): GetCommandOutput {
  if (!output || output === "null") {
    return null;
  }

  const parsed: unknown = JSON.parse(output);
  return parsed === null
    ? null
    : parseWithSchema<MediaState>(MediaStateSchema, parsed, "mediaremote-adapter get returned invalid JSON");
}

function parseStreamMessage(line: string): StreamMessage {
  return parseWithSchema<StreamMessage>(
    StreamMessageSchema,
    JSON.parse(line) as unknown,
    "mediaremote-adapter stream returned invalid JSON",
  );
}

async function refreshStateFromGet(): Promise<boolean> {
  try {
    const output = runOrThrow(buildAdapterCommand("get", "--micros"), "mediaremote-adapter get failed");
    const mutationId = ++stateMutationId;
    const nextState = await resolveSong(currentState, normalizeState(parseGetCommandOutput(output)));

    if (mutationId === stateMutationId) {
      currentState = nextState;
    }

    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function runControl(args: string[]): void {
  runOrThrow([adapterPaths.mediaControl, ...args], `Control failed: ${args.join(" ")}`);
}

function ensureAdapterWorks(): void {
  if (!adapterPaths.helper) {
    return;
  }

  runOrThrow(buildAdapterCommand("test"), "mediaremote-adapter test failed");
}

async function refreshAndBroadcast(server: ServerType): Promise<void> {
  if (await refreshStateFromGet()) {
    broadcast(server);
  }
}

function startStream(server: ServerType): void {
  streamProcess?.kill();

  streamProcess = Bun.spawn({
    cmd: buildAdapterCommand("stream", "--debounce=80", "--micros"),
    stdout: "pipe",
    stderr: "pipe",
  });

  void readJsonLines(streamProcess.stdout, async (line) => {
    const message = parseStreamMessage(line);
    if (message.type === "data") {
      const mutationId = ++stateMutationId;
      const nextState = await mergeState(currentState, message.payload, message.diff);
      if (mutationId === stateMutationId) {
        currentState = nextState;
        broadcast(server);
      }
      return;
    }

    if (message.type === "error") {
      console.error(message.message ?? "mediaremote-adapter stream error");
    }
  });

  void readJsonLines(streamProcess.stderr, (line) => {
    console.error(line);
  });

  void streamProcess.exited.then(() => {
    streamProcess = null;
    setTimeout(() => startStream(server), 1000);
  });
}

ensureAdapterWorks();
await refreshStateFromGet();

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const hostname = process.env.HOSTNAME ?? "music.localhost";

const server = Bun.serve<{ subscribed: boolean }>({
    hostname,
    port: Number(process.env.PORT ?? 3000),
    routes: {
        "/": html,
    },
  async fetch(req, serverInstance) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true, playing: currentState !== null }));
    }

    if (url.pathname === "/ws") {
      return serverInstance.upgrade(req, { data: { subscribed: false } })
        ? withCors(new Response(null))
        : withCors(new Response("WebSocket upgrade failed", { status: 400 }));
    }

    if (url.pathname === "/api/control" && req.method === "POST") {
      const payload: unknown = await req.json();
      let body: ControlRequest;

      try {
        body = parseWithSchema<ControlRequest>(ControlRequestSchema, payload, "Invalid command");
      } catch {
        return withCors(Response.json({ ok: false, error: "Invalid command" }, { status: 400 }));
      }

      try {
        runControl([body.command]);
        await refreshAndBroadcast(server);
        return withCors(Response.json({ ok: true }));
      } catch (error) {
        return withCors(Response.json(
          { ok: false, error: error instanceof Error ? error.message : "Control failed" },
          { status: 500 },
        ));
      }
    }

    if (url.pathname === "/api/seek" && req.method === "POST") {
      const payload: unknown = await req.json();
      let body: SeekRequest;

      try {
        body = parseWithSchema<SeekRequest>(SeekRequestSchema, payload, "Invalid seek position");
      } catch {
        return withCors(Response.json({ ok: false, error: "Invalid seek position" }, { status: 400 }));
      }

      try {
        runControl(["seek", String(body.positionSeconds)]);
        await refreshAndBroadcast(server);
        return withCors(Response.json({ ok: true }));
      } catch (error) {
        return withCors(Response.json(
          { ok: false, error: error instanceof Error ? error.message : "Seek failed" },
          { status: 500 },
        ));
      }
    }

    return withCors(new Response("Not found", { status: 404 }));
  },
  websocket: {
    open(ws) {
      ws.subscribe("updates");
      ws.data.subscribed = true;
      ws.send(JSON.stringify(currentState));
    },
    message() {},
    close(ws) {
      if (ws.data.subscribed) {
        ws.unsubscribe("updates");
      }
    },
  },
});

startStream(server);

setInterval(() => {
  void (async () => {
    const before = JSON.stringify(currentState);
    if (!await refreshStateFromGet()) {
      return;
    }

    if (JSON.stringify(currentState) !== before) {
      broadcast(server);
    }
  })();
}, 2000);

console.log(`Listening on http://${hostname}:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    streamProcess?.kill();
    process.exit(0);
  });
}
