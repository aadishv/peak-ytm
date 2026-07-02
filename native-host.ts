import { WebSocketServer, type WebSocket } from 'ws';

type NativeHostMessage =
  | { type: 'INIT' }
  | { type: 'PLAYER_STATE'; data?: unknown };

type NativeHostEventMessage =
  | {
      type: 'NATIVE_HOST_STARTED';
      version: string;
      transport: 'websocket';
      host: string;
      port: number;
      arrpcBridgeHost: string;
      arrpcBridgePort: number;
    }
  | {
      type: 'RPC_STATUS_UPDATE';
      status: 'connected' | 'disconnected';
      user?: { username?: string; discriminator?: string };
    }
  | {
      type: 'NATIVE_HOST_ERROR' | 'NATIVE_HOST_WARNING';
      message: string;
      errorType?: string;
      errorDetails?: Record<string, unknown>;
    }
  | {
      type: 'ACTIVITY_STATUS';
      status: 'success' | 'error' | 'cleared' | 'clear_error';
      message?: string;
      activity?: unknown;
    };

type NormalizedPlayerState = {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  trackUrl?: string;
  playbackState?: string;
  durationMs?: number;
  positionMs?: number;
  measuredAtMs?: number;
  raw: unknown;
};

type ArRpcButton = { label: string; url: string };

type ArRpcActivity = {
  application_id: string;
  name: string;
  type: number;
  details?: string;
  state?: string;
  timestamps?: { start?: number; end?: number };
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
  metadata?: { button_urls?: string[] };
  buttons?: ArRpcButton[];
  flags: number;
  instance?: boolean;
};

type ArRpcActivityMessage = {
  activity: ArRpcActivity | null;
  pid: number;
  socketId: string;
};

const NATIVE_HOST_VERSION = '1.1.0';
const clientId = '1242988484671705208';
const CONTROL_WS_HOST = process.env.YTM_RPC_WS_HOST || '127.0.0.1';
const CONTROL_WS_PORT = Number(process.env.YTM_RPC_WS_PORT || 32145);
const ARRPC_WS_HOST = process.env.YTM_ARRPC_WS_HOST || '127.0.0.1';
const ARRPC_WS_PORT = Number(process.env.YTM_ARRPC_WS_PORT || 1337);
const EXT_POLL_INTERVAL_MS = 1_500;
const STALE_ACTIVITY_TIMEOUT_MS = EXT_POLL_INTERVAL_MS + 500;
const ARRPC_SOCKET_ID = '0';

let messageProcessingPromise: Promise<void> = Promise.resolve();
let staleActivityTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivitySignature: string | null = null;
let lastActivityStartTimestamp: number | null = null;
let lastActivityEndTimestamp: number | null = null;
let currentActivity: ArRpcActivityMessage | null = null;
const controlClients = new Set<WebSocket>();
const arrpcClients = new Set<WebSocket>();

const controlWss = new WebSocketServer({ host: CONTROL_WS_HOST, port: CONTROL_WS_PORT });
const arrpcWss = new WebSocketServer({ host: ARRPC_WS_HOST, port: ARRPC_WS_PORT });

function sendToExtension(
  messageObject: NativeHostEventMessage,
  targetClient?: WebSocket,
) {
  try {
    const jsonMessage = JSON.stringify(messageObject);
    const recipients = targetClient ? [targetClient] : [...controlClients];

    for (const client of recipients) {
      if (client.readyState === client.OPEN) {
        client.send(jsonMessage);
      }
    }
  } catch {
    // noop
  }
}

function logExtensionEvent(label: string, payload: unknown) {
  try {
    console.log(`[extension] ${label}: ${JSON.stringify(payload)}`);
  } catch {
    console.log(`[extension] ${label}`);
  }
}

function sendToArRpcClients(message: ArRpcActivityMessage) {
  const jsonMessage = JSON.stringify(message);

  for (const client of arrpcClients) {
    if (client.readyState === client.OPEN) {
      client.send(jsonMessage);
    }
  }
}

function clearStaleActivityTimer() {
  if (staleActivityTimer) {
    clearTimeout(staleActivityTimer);
    staleActivityTimer = null;
  }
}

function armStaleActivityTimer() {
  clearStaleActivityTimer();
  staleActivityTimer = setTimeout(() => {
    logExtensionEvent('activity_stale_timeout', {
      timeoutMs: STALE_ACTIVITY_TIMEOUT_MS,
    });
    void clearActivity();
  }, STALE_ACTIVITY_TIMEOUT_MS);
}

function sendCurrentStatus(targetClient?: WebSocket) {
  sendToExtension(
    {
      type: 'NATIVE_HOST_STARTED',
      version: NATIVE_HOST_VERSION,
      transport: 'websocket',
      host: CONTROL_WS_HOST,
      port: CONTROL_WS_PORT,
      arrpcBridgeHost: ARRPC_WS_HOST,
      arrpcBridgePort: ARRPC_WS_PORT,
    },
    targetClient,
  );

  sendToExtension(
    {
      type: 'RPC_STATUS_UPDATE',
      status: 'connected',
      user: {
        username: 'arRPC',
        discriminator: 'bridge',
      },
    },
    targetClient,
  );
}

async function handleMessage(message: NativeHostMessage) {
  switch (message.type) {
    case 'INIT':
      break;
    case 'PLAYER_STATE':
      armStaleActivityTimer();
      await setPlayerState(message.data);
      break;
    default:
      sendToExtension({
        type: 'NATIVE_HOST_WARNING',
        message: `Unknown message type: ${(message as { type?: string }).type}`,
      });
  }
}

controlWss.on('connection', (socket) => {
  controlClients.add(socket);
  logExtensionEvent('connected', { clients: controlClients.size });
  sendCurrentStatus(socket);

  socket.on('message', (rawMessage) => {
    let message: NativeHostMessage;

    try {
      message = JSON.parse(rawMessage.toString('utf8')) as NativeHostMessage;
    } catch (error) {
      sendToExtension(
        {
          type: 'NATIVE_HOST_ERROR',
          message: `Error parsing message: ${error instanceof Error ? error.message : String(error)}`,
        },
        socket,
      );
      return;
    }

    messageProcessingPromise = messageProcessingPromise
      .then(() => handleMessage(message))
      .catch((error) => {
        sendToExtension(
          {
            type: 'NATIVE_HOST_ERROR',
            message: `Error handling message: ${error instanceof Error ? error.message : String(error)}`,
          },
          socket,
        );
      });
  });

  socket.on('close', () => {
    controlClients.delete(socket);
    logExtensionEvent('disconnected', { clients: controlClients.size });
  });

  socket.on('error', (error) => {
    logExtensionEvent('socket_error', { message: error.message });
    sendToExtension({
      type: 'NATIVE_HOST_ERROR',
      message: `WebSocket Error: ${error.message}`,
    });
  });
});

arrpcWss.on('connection', (socket) => {
  arrpcClients.add(socket);

  if (currentActivity && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(currentActivity));
  }

  socket.on('close', () => {
    arrpcClients.delete(socket);
  });

  socket.on('error', (error) => {
    console.error('arRPC bridge socket error:', error);
  });
});

controlWss.on('listening', () => {
  sendToExtension({
    type: 'NATIVE_HOST_STARTED',
    version: NATIVE_HOST_VERSION,
    transport: 'websocket',
    host: CONTROL_WS_HOST,
    port: CONTROL_WS_PORT,
    arrpcBridgeHost: ARRPC_WS_HOST,
    arrpcBridgePort: ARRPC_WS_PORT,
  });
});

controlWss.on('error', (error) => {
  console.error('Control WebSocket server error:', error);
});

arrpcWss.on('error', (error) => {
  console.error('arRPC bridge WebSocket server error:', error);
});

function getFirstString(...values: unknown[]) {
  return values.find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
}

function getFirstNumber(...values: unknown[]) {
  return values.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

function normalizePlayerState(playerState: unknown): NormalizedPlayerState | null {
  if (!playerState || typeof playerState !== 'object') {
    return null;
  }

  const state = playerState as Record<string, unknown>;
  const playbackState = getFirstString(
    state.playbackState,
    state.playerState,
    state.status,
    state.state,
  )?.toLowerCase();

  const timestampEpochMicros = getFirstNumber(
    state.timestampEpochMicros,
    state.timestampMicros,
  );

  return {
    title: getFirstString(state.title, state.songTitle, state.name),
    artist: getFirstString(state.artist, state.artistName, state.author),
    album: getFirstString(state.album, state.albumName),
    artworkUrl: getFirstString(
      state.artworkUrl,
      state.albumArtUrl,
      state.imageUrl,
      state.thumbnailUrl,
    ),
    trackUrl: getFirstString(state.trackUrl, state.songUrl, state.url),
    playbackState,
    durationMs: getFirstNumber(state.durationMs, state.duration),
    positionMs: getFirstNumber(state.positionMs, state.position, state.currentTimeMs),
    measuredAtMs:
      typeof timestampEpochMicros === 'number'
        ? Math.round(timestampEpochMicros / 1000)
        : undefined,
    raw: playerState,
  };
}

function buildArRpcActivity(playerState: unknown): ArRpcActivity | null {
  const normalized = normalizePlayerState(playerState);
  if (!normalized || !normalized.title || normalized.playbackState === 'paused') {
    return null;
  }

  const buttons: ArRpcButton[] | undefined = normalized.trackUrl
    ? [{ label: 'Open in YouTube Music', url: normalized.trackUrl }]
    : undefined;

  const activity: ArRpcActivity = {
    application_id: clientId,
    name: 'YouTube Music',
    type: 2,
    details: normalized.title,
    state: normalized.artist || undefined,
    assets: {
      large_image: normalized.artworkUrl,
      large_text: normalized.album || '',
    },
    metadata: buttons ? { button_urls: buttons.map((button) => button.url) } : undefined,
    buttons,
    flags: 0,
  };

  if (
    typeof normalized.positionMs === 'number' &&
    typeof normalized.durationMs === 'number' &&
    normalized.durationMs > normalized.positionMs
  ) {
    const measuredAtMs = normalized.measuredAtMs ?? Date.now();
    const startedAtMs = measuredAtMs - normalized.positionMs;
    const endsAtMs = startedAtMs + normalized.durationMs;

    activity.timestamps = {
      start: startedAtMs,
      end: endsAtMs,
    };
  }

  return activity;
}

function getActivitySignature(activity: ArRpcActivity): string {
  return JSON.stringify({
    name: activity.name,
    type: activity.type,
    details: activity.details,
    state: activity.state,
    assets: activity.assets,
    metadata: activity.metadata,
    buttons: activity.buttons,
    flags: activity.flags,
  });
}

function shouldSendActivityUpdate(activity: ArRpcActivity): boolean {
  const signature = getActivitySignature(activity);
  const sameSignature = signature === lastActivitySignature;

  if (!sameSignature) {
    return true;
  }

  const startTimestamp = activity.timestamps?.start;
  const endTimestamp = activity.timestamps?.end;

  if (
    startTimestamp == null ||
    endTimestamp == null ||
    lastActivityStartTimestamp == null ||
    lastActivityEndTimestamp == null
  ) {
    return false;
  }

  return (
    Math.abs(startTimestamp - lastActivityStartTimestamp) > 1_000 ||
    Math.abs(endTimestamp - lastActivityEndTimestamp) > 1_000
  );
}

function rememberActivity(activity: ArRpcActivity): void {
  lastActivitySignature = getActivitySignature(activity);
  lastActivityStartTimestamp = activity.timestamps?.start ?? null;
  lastActivityEndTimestamp = activity.timestamps?.end ?? null;
}

function forgetActivity(): void {
  lastActivitySignature = null;
  lastActivityStartTimestamp = null;
  lastActivityEndTimestamp = null;
}

async function setPlayerState(playerState: unknown) {
  const activity = buildArRpcActivity(playerState);

  if (!activity) {
    clearStaleActivityTimer();
    logExtensionEvent('clearing_activity', {
      reason: 'paused_or_invalid',
      playerState,
    });
    await clearActivity();
    return;
  }

  if (!shouldSendActivityUpdate(activity)) {
    return;
  }

  logExtensionEvent('setting_activity', activity);
  await setArRpcActivity(activity);
}

async function setArRpcActivity(activityData: ArRpcActivity) {
  try {
    currentActivity = {
      activity: activityData,
      pid: process.pid,
      socketId: ARRPC_SOCKET_ID,
    };
    rememberActivity(activityData);
    sendToArRpcClients(currentActivity);
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'success',
      activity: currentActivity,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'error',
      message: `Failed to set activity: ${error.message}`,
    });
  }
}

async function clearActivity() {
  try {
    currentActivity = {
      activity: null,
      pid: process.pid,
      socketId: ARRPC_SOCKET_ID,
    };
    forgetActivity();
    sendToArRpcClients(currentActivity);
    logExtensionEvent('activity_cleared', {});
    sendToExtension({ type: 'ACTIVITY_STATUS', status: 'cleared' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'clear_error',
      message: `Failed to clear activity: ${error.message}`,
    });
  }
}

function shutdownAndExit(exitCode = 0) {
  for (const client of controlClients) {
    try {
      client.close();
    } catch {
      // noop
    }
  }

  for (const client of arrpcClients) {
    try {
      client.close();
    } catch {
      // noop
    }
  }

  controlWss.close();
  arrpcWss.close();
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  clearStaleActivityTimer();
  shutdownAndExit(0);
});

process.on('SIGTERM', () => {
  clearStaleActivityTimer();
  shutdownAndExit(0);
});
