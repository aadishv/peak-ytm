import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { WebSocket, WebSocketServer } from "ws";
import {
    isClientMessage,
    type ClientMessage,
    type ClientRole,
    type PlayerSnapshot,
    type ServerMessage,
} from "./shared/protocol.ts";

const ENV_FILE_URL = new URL("./.env.local", import.meta.url);

try {
    process.loadEnvFile(ENV_FILE_URL);
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

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

type ControlClient = {
    socket: WebSocket;
    role: ClientRole | null;
    clientId: string | null;
    snapshot: PlayerSnapshot | null;
    updatedAt: number;
    updateOrder: number;
};

type LastFmConfig = {
    apiKey: string;
    apiSecret: string;
    sessionKey: string;
};

type LastFmAuthResponse = {
    token?: string;
    session?: { key?: string; name?: string };
    error?: number;
    message?: string;
};

const DISCORD_CLIENT_ID = "1242988484671705208";
const CONTROL_WS_HOST = "127.0.0.1";
const CONTROL_WS_PORT = Number(process.env.YTM_RPC_WS_PORT || 32145);
const ARRPC_WS_HOST = "127.0.0.1";
const ARRPC_WS_PORT = Number(process.env.YTM_ARRPC_WS_PORT || 1337);
const PLAYER_UPDATE_INTERVAL_MS = 1_500;
const STALE_PLAYER_TIMEOUT_MS = PLAYER_UPDATE_INTERVAL_MS + 1_500;
const ARRPC_SOCKET_ID = "0";
const LAST_FM_API_URL = "https://ws.audioscrobbler.com/2.0/";

function sendJson(socket: WebSocket, message: ServerMessage | ArRpcActivityMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;

    try {
        socket.send(JSON.stringify(message));
    } catch (error) {
        console.error("Failed to send WebSocket message:", error);
    }
}

function signLastFmParams(params: Record<string, string>, apiSecret: string): string {
    const signatureInput = Object.entries(params)
        .filter(([key]) => key !== "format" && key !== "callback")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}${value}`)
        .join("");

    return createHash("md5").update(signatureInput + apiSecret, "utf8").digest("hex");
}

async function callLastFmAuth(
    params: Record<string, string>,
    apiSecret: string,
): Promise<LastFmAuthResponse> {
    const signedParams = {
        ...params,
        api_sig: signLastFmParams(params, apiSecret),
        format: "json",
    };
    const response = await fetch(`${LAST_FM_API_URL}?${new URLSearchParams(signedParams)}`);
    const body = (await response.json()) as LastFmAuthResponse;

    if (!response.ok || body.error) {
        throw new Error(body.message || `Last.fm returned HTTP ${response.status}`);
    }
    return body;
}

function openBrowser(url: string): void {
    const command =
        process.platform === "darwin"
            ? ["open", url]
            : process.platform === "win32"
              ? ["cmd", "/c", "start", "", url]
              : ["xdg-open", url];
    const child = spawn(command[0], command.slice(1), {
        detached: true,
        stdio: "ignore",
    });
    child.on("error", () => {
        // The URL is also printed for systems without a browser opener.
    });
    child.unref();
}

async function writeEnvValue(key: string, value: string): Promise<void> {
    const contents = await readFile(ENV_FILE_URL, "utf8");
    const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const lines = contents.split(/\r?\n/);
    const nextLine = `${key}=${JSON.stringify(value)}`;
    let replaced = false;

    const updatedLines: string[] = [];
    for (const line of lines) {
        if (!keyPattern.test(line)) {
            updatedLines.push(line);
        } else if (!replaced) {
            updatedLines.push(nextLine);
            replaced = true;
        }
    }
    if (!replaced) {
        while (updatedLines.at(-1) === "") updatedLines.pop();
        updatedLines.push(nextLine);
    }

    await writeFile(ENV_FILE_URL, `${updatedLines.join("\n")}\n`, "utf8");
}

async function authorizeLastFm(): Promise<void> {
    await readFile(ENV_FILE_URL, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("Create .env.local from .env.example before authorizing Last.fm");
        }
        throw error;
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const apiSecret = process.env.LASTFM_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error("Set LASTFM_API_KEY and LASTFM_API_SECRET in .env.local first");
    }

    const tokenResponse = await callLastFmAuth(
        { method: "auth.getToken", api_key: apiKey },
        apiSecret,
    );
    if (!tokenResponse.token) throw new Error("Last.fm did not return an auth token");

    const authorizationUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(tokenResponse.token)}`;
    console.log(`Authorize peak ytm at:\n${authorizationUrl}\n`);
    openBrowser(authorizationUrl);

    const prompt = createInterface({ input: stdin, output: stdout });
    try {
        await prompt.question("Press Enter after approving access in Last.fm...");
    } finally {
        prompt.close();
    }

    const sessionResponse = await callLastFmAuth(
        {
            method: "auth.getSession",
            api_key: apiKey,
            token: tokenResponse.token,
        },
        apiSecret,
    );
    const sessionKey = sessionResponse.session?.key;
    if (!sessionKey) throw new Error("Last.fm did not return a session key");

    await writeEnvValue("LASTFM_SESSION_KEY", sessionKey);
    console.log(
        `Authorized as ${sessionResponse.session?.name ?? "unknown user"}; LASTFM_SESSION_KEY was saved to .env.local`,
    );
}

class LastFmClient {
    private title: string | null = null;
    private artist: string | null = null;
    private album: string | null = null;
    private startedAtSeconds = 0;
    private scrobbled = false;
    private scrobbleTimer: ReturnType<typeof setTimeout> | null = null;
    private activeTimerId: number | null = null;
    private timerSequence = 0;
    private readonly config: LastFmConfig;

    constructor(config: LastFmConfig) {
        this.config = config;
    }

    pause(reason = "player state cleared"): void {
        this.log("pause", { reason });
        this.cancelScrobbleTimer(reason);
    }

    update(snapshot: PlayerSnapshot): void {
        const elapsedSeconds = snapshot.elapsedTimeMicros / 1_000_000;
        const durationSeconds = snapshot.durationMicros / 1_000_000;
        this.log("state-update", {
            incoming: {
                title: snapshot.title,
                artist: snapshot.artist,
                album: snapshot.album,
                playing: snapshot.playing,
                elapsedSeconds,
                durationSeconds,
                timestampEpochSeconds: snapshot.timestampEpochMicros / 1_000_000,
                inferredStartedAtSeconds:
                    (snapshot.timestampEpochMicros - snapshot.elapsedTimeMicros) /
                    1_000_000,
            },
            current: {
                title: this.title,
                artist: this.artist,
                album: this.album,
                startedAtSeconds: this.startedAtSeconds,
                scrobbled: this.scrobbled,
                activeTimerId: this.activeTimerId,
            },
        });

        if (!snapshot.playing || !snapshot.title || !snapshot.artist) {
            this.pause("snapshot is paused or missing title/artist");
            return;
        }

        const trackChanged =
            snapshot.title !== this.title ||
            snapshot.artist !== this.artist ||
            snapshot.album !== this.album;

        if (trackChanged) {
            const previousTrack = {
                title: this.title,
                artist: this.artist,
                album: this.album,
                startedAtSeconds: this.startedAtSeconds,
                scrobbled: this.scrobbled,
            };
            this.cancelScrobbleTimer("track metadata changed");
            this.title = snapshot.title;
            this.artist = snapshot.artist;
            this.album = snapshot.album;
            this.startedAtSeconds = Math.floor(
                (snapshot.timestampEpochMicros - snapshot.elapsedTimeMicros) / 1_000_000,
            );
            this.scrobbled = false;

            this.log("track-changed", {
                previous: previousTrack,
                current: {
                    title: this.title,
                    artist: this.artist,
                    album: this.album,
                    startedAtSeconds: this.startedAtSeconds,
                },
            });
            void this.submit("track.updateNowPlaying", snapshot).catch((error) => {
                this.log("now-playing-failed", { error: String(error) });
            });
        }

        if (!this.scrobbled && !this.scrobbleTimer) {
            this.scheduleScrobble(snapshot);
        }
    }

    private scheduleScrobble(snapshot: PlayerSnapshot): void {
        const durationSeconds = snapshot.durationMicros / 1_000_000;
        if (durationSeconds <= 30) {
            this.log("timer-not-scheduled", {
                reason: "duration is not longer than 30 seconds",
                durationSeconds,
            });
            return;
        }

        const elapsedSeconds = snapshot.elapsedTimeMicros / 1_000_000;
        const thresholdSeconds = Math.min(durationSeconds / 2, 240);
        const remainingSeconds = Math.max(0, thresholdSeconds - elapsedSeconds);
        const title = this.title;
        const artist = this.artist;
        const album = this.album;
        const timerId = ++this.timerSequence;

        const timer = setTimeout(() => {
            const stillCurrent =
                this.scrobbleTimer === timer &&
                !this.scrobbled &&
                this.title === title &&
                this.artist === artist &&
                this.album === album;

            this.log("timer-fired", {
                timerId,
                scheduledTrack: { title, artist, album },
                currentTrack: {
                    title: this.title,
                    artist: this.artist,
                    album: this.album,
                },
                scrobbled: this.scrobbled,
                activeTimerId: this.activeTimerId,
                stillCurrent,
            });
            if (!stillCurrent) return;

            this.scrobbleTimer = null;
            this.activeTimerId = null;
            this.scrobbled = true;
            this.log("scrobble-dispatched", {
                timerId,
                title,
                artist,
                album,
                startedAtSeconds: this.startedAtSeconds,
            });
            void this.submit("track.scrobble", snapshot, this.startedAtSeconds).catch(
                (error) => {
                    this.log("scrobble-failed", { timerId, error: String(error) });
                },
            );
        }, remainingSeconds * 1_000);

        this.scrobbleTimer = timer;
        this.activeTimerId = timerId;
        this.log("timer-scheduled", {
            timerId,
            title,
            artist,
            album,
            elapsedSeconds,
            durationSeconds,
            thresholdSeconds,
            remainingSeconds,
            startedAtSeconds: this.startedAtSeconds,
            firesAt: new Date(Date.now() + remainingSeconds * 1_000).toISOString(),
        });
    }

    private cancelScrobbleTimer(reason: string): void {
        if (!this.scrobbleTimer) return;
        this.log("timer-canceled", { timerId: this.activeTimerId, reason });
        clearTimeout(this.scrobbleTimer);
        this.scrobbleTimer = null;
        this.activeTimerId = null;
    }

    private log(event: string, details: Record<string, unknown>): void {
        console.log(
            JSON.stringify({
                source: "lastfm",
                at: new Date().toISOString(),
                pid: process.pid,
                event,
                ...details,
            }),
        );
    }

    private async submit(
        method: "track.updateNowPlaying" | "track.scrobble",
        snapshot: PlayerSnapshot,
        startedAtSeconds?: number,
    ): Promise<void> {
        const params: Record<string, string> = {
            method,
            api_key: this.config.apiKey,
            sk: this.config.sessionKey,
            artist: snapshot.artist,
            track: snapshot.title,
            duration: String(Math.max(0, Math.round(snapshot.durationMicros / 1_000_000))),
        };

        if (snapshot.album) params.album = snapshot.album;
        if (startedAtSeconds !== undefined) params.timestamp = String(startedAtSeconds);

        this.log("api-request", {
            method,
            artist: params.artist,
            track: params.track,
            album: params.album,
            duration: params.duration,
            timestamp: params.timestamp,
        });

        params.api_sig = signLastFmParams(params, this.config.apiSecret);
        params.format = "json";

        const response = await fetch(LAST_FM_API_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params),
        });
        const body = (await response.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;

        this.log("api-response", {
            method,
            status: response.status,
            ok: response.ok,
            body,
        });
        const errorCode = typeof body?.error === "number" ? body.error : null;
        const errorMessage = typeof body?.message === "string" ? body.message : null;
        if (!response.ok || errorCode) {
            throw new Error(errorMessage || `HTTP ${response.status}`);
        }
    }
}

class ArRpcBridge {
    private readonly clients = new Set<WebSocket>();
    private currentMessage: ArRpcActivityMessage | null = null;
    private lastSignature: string | null = null;
    private lastStartTimestamp: number | null = null;
    private lastEndTimestamp: number | null = null;

    addClient(socket: WebSocket): void {
        this.clients.add(socket);
        if (this.currentMessage) sendJson(socket, this.currentMessage);

        socket.on("close", () => this.clients.delete(socket));
        socket.on("error", (error) => {
            console.error("arRPC bridge socket error:", error.message);
        });
    }

    update(snapshot: PlayerSnapshot): void {
        const activity = this.buildActivity(snapshot);
        if (!activity) {
            this.clear();
            return;
        }
        if (!this.shouldSend(activity)) return;

        this.currentMessage = {
            activity,
            pid: process.pid,
            socketId: ARRPC_SOCKET_ID,
        };
        this.remember(activity);
        this.broadcast(this.currentMessage);
    }

    clear(): void {
        if (this.currentMessage?.activity === null) return;

        this.currentMessage = {
            activity: null,
            pid: process.pid,
            socketId: ARRPC_SOCKET_ID,
        };
        this.lastSignature = null;
        this.lastStartTimestamp = null;
        this.lastEndTimestamp = null;
        this.broadcast(this.currentMessage);
    }

    closeClients(): void {
        for (const client of this.clients) client.close();
    }

    private buildActivity(snapshot: PlayerSnapshot): ArRpcActivity | null {
        if (!snapshot.title || !snapshot.playing) return null;

        const searchQuery = [snapshot.artist, snapshot.title].filter(Boolean).join(" ");
        const buttons: ArRpcButton[] | undefined = searchQuery
            ? [
                  {
                      label: "Open in YouTube Music",
                      url: `https://music.youtube.com/search?q=${encodeURIComponent(searchQuery)}`,
                  },
              ]
            : undefined;
        const startedAtMs = Math.round(
            (snapshot.timestampEpochMicros - snapshot.elapsedTimeMicros) / 1_000,
        );
        const durationMs = Math.round(snapshot.durationMicros / 1_000);

        return {
            application_id: DISCORD_CLIENT_ID,
            name: "YouTube Music",
            type: 2,
            details: snapshot.title,
            state: snapshot.artist || undefined,
            timestamps:
                durationMs > 0
                    ? { start: startedAtMs, end: startedAtMs + durationMs }
                    : undefined,
            assets: {
                large_image: snapshot.artworkUrl || undefined,
                large_text: snapshot.album || "",
            },
            metadata: buttons ? { button_urls: buttons.map((button) => button.url) } : undefined,
            buttons,
            flags: 0,
        };
    }

    private getSignature(activity: ArRpcActivity): string {
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

    private shouldSend(activity: ArRpcActivity): boolean {
        if (this.getSignature(activity) !== this.lastSignature) return true;

        const start = activity.timestamps?.start;
        const end = activity.timestamps?.end;
        if (
            start == null ||
            end == null ||
            this.lastStartTimestamp == null ||
            this.lastEndTimestamp == null
        ) {
            return false;
        }

        return (
            Math.abs(start - this.lastStartTimestamp) > 1_000 ||
            Math.abs(end - this.lastEndTimestamp) > 1_000
        );
    }

    private remember(activity: ArRpcActivity): void {
        this.lastSignature = this.getSignature(activity);
        this.lastStartTimestamp = activity.timestamps?.start ?? null;
        this.lastEndTimestamp = activity.timestamps?.end ?? null;
    }

    private broadcast(message: ArRpcActivityMessage): void {
        for (const client of this.clients) sendJson(client, message);
    }
}

class PlayerManager {
    private readonly clients = new Map<WebSocket, ControlClient>();
    private readonly arRpc: ArRpcBridge;
    private readonly lastFm: LastFmClient | null;
    private activePlayer: ControlClient | null = null;
    private currentSnapshot: PlayerSnapshot | null = null;
    private staleTimer: ReturnType<typeof setTimeout> | null = null;
    private updateSequence = 0;

    constructor(arRpc: ArRpcBridge, lastFm: LastFmClient | null) {
        this.arRpc = arRpc;
        this.lastFm = lastFm;
    }

    addClient(socket: WebSocket): void {
        const client: ControlClient = {
            socket,
            role: null,
            clientId: null,
            snapshot: null,
            updatedAt: 0,
            updateOrder: 0,
        };
        this.clients.set(socket, client);

        socket.on("message", (rawMessage) => {
            let message: unknown;
            try {
                message = JSON.parse(rawMessage.toString("utf8"));
            } catch {
                this.sendError(client, "Invalid JSON message");
                return;
            }

            if (!isClientMessage(message)) {
                this.sendError(client, "Invalid or unknown message");
                return;
            }

            this.handleMessage(client, message);
        });

        socket.on("close", () => this.removeClient(client));
        socket.on("error", (error) => {
            console.error("Control socket error:", error.message);
        });
    }

    closeClients(): void {
        if (this.staleTimer) clearTimeout(this.staleTimer);
        for (const client of this.clients.values()) client.socket.close();
    }

    private handleMessage(client: ControlClient, message: ClientMessage): void {
        if (message.type === "HELLO") {
            if (client.role !== null) {
                this.sendError(client, "HELLO has already been received");
                return;
            }
            client.role = message.role;
            client.clientId = message.clientId;
            if (message.role === "visualizer") {
                sendJson(client.socket, {
                    type: "STATE_UPDATE",
                    payload: this.currentSnapshot,
                });
            }
            return;
        }

        if (client.role === null) {
            this.sendError(client, "HELLO must be sent first");
            return;
        }

        if (message.type === "PLAYER_SNAPSHOT") {
            if (client.role !== "player") {
                this.sendError(client, "Only player clients may publish snapshots");
                return;
            }
            this.receiveSnapshot(client, message.payload);
            return;
        }

        if (client.role !== "visualizer") {
            this.sendError(client, "Only visualizer clients may send controls");
            return;
        }

        if (!this.activePlayer || this.activePlayer.socket.readyState !== WebSocket.OPEN) {
            this.sendError(client, "No active player is connected");
            return;
        }

        sendJson(this.activePlayer.socket, message);
    }

    private receiveSnapshot(client: ControlClient, snapshot: PlayerSnapshot): void {
        client.snapshot = snapshot;
        client.updatedAt = Date.now();
        client.updateOrder = ++this.updateSequence;

        const previousActive = this.activePlayer;
        this.activePlayer = this.selectActivePlayer();
        console.log(
            JSON.stringify({
                source: "player-manager",
                at: new Date().toISOString(),
                pid: process.pid,
                event: "snapshot-received",
                clientId: client.clientId,
                updateOrder: client.updateOrder,
                snapshot: {
                    title: snapshot.title,
                    artist: snapshot.artist,
                    album: snapshot.album,
                    playing: snapshot.playing,
                    elapsedSeconds: snapshot.elapsedTimeMicros / 1_000_000,
                    durationSeconds: snapshot.durationMicros / 1_000_000,
                },
                previousActiveClientId: previousActive?.clientId ?? null,
                activeClientId: this.activePlayer?.clientId ?? null,
                connectedPlayers: [...this.clients.values()]
                    .filter((connected) => connected.role === "player")
                    .map((connected) => ({
                        clientId: connected.clientId,
                        playing: connected.snapshot?.playing ?? null,
                        title: connected.snapshot?.title ?? null,
                        updateOrder: connected.updateOrder,
                    })),
            }),
        );
        if (this.activePlayer !== previousActive || this.activePlayer === client) {
            this.publishActiveSnapshot();
        }
    }

    private selectActivePlayer(): ControlClient | null {
        const players = [...this.clients.values()].filter(
            (client) => client.role === "player" && client.snapshot !== null,
        );
        const playingPlayers = players.filter((client) => client.snapshot?.playing);
        const candidates = playingPlayers.length > 0 ? playingPlayers : players;

        return candidates.reduce<ControlClient | null>(
            (latest, client) =>
                !latest || client.updateOrder > latest.updateOrder ? client : latest,
            null,
        );
    }

    private publishActiveSnapshot(): void {
        const snapshot = this.activePlayer?.snapshot ?? null;
        if (!snapshot) {
            this.clearState();
            return;
        }

        this.currentSnapshot = snapshot;
        this.broadcastState(snapshot);
        this.arRpc.update(snapshot);
        this.lastFm?.update(snapshot);
        this.armStaleTimer();
    }

    private armStaleTimer(): void {
        if (this.staleTimer) clearTimeout(this.staleTimer);
        if (!this.activePlayer) return;

        const activePlayer = this.activePlayer;
        const remainingMs = Math.max(
            0,
            STALE_PLAYER_TIMEOUT_MS - (Date.now() - activePlayer.updatedAt),
        );
        this.staleTimer = setTimeout(() => {
            this.staleTimer = null;
            if (
                this.activePlayer !== activePlayer ||
                Date.now() - activePlayer.updatedAt < STALE_PLAYER_TIMEOUT_MS
            ) {
                this.armStaleTimer();
                return;
            }

            activePlayer.snapshot = null;
            this.activePlayer = this.selectActivePlayer();
            this.publishActiveSnapshot();
        }, remainingMs);
    }

    private removeClient(client: ControlClient): void {
        this.clients.delete(client.socket);
        if (this.activePlayer !== client) return;

        this.activePlayer = this.selectActivePlayer();
        this.publishActiveSnapshot();
    }

    private clearState(): void {
        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }
        this.currentSnapshot = null;
        this.broadcastState(null);
        this.arRpc.clear();
        this.lastFm?.pause();
    }

    private broadcastState(snapshot: PlayerSnapshot | null): void {
        for (const client of this.clients.values()) {
            if (client.role === "visualizer") {
                sendJson(client.socket, { type: "STATE_UPDATE", payload: snapshot });
            }
        }
    }

    private sendError(client: ControlClient, message: string): void {
        sendJson(client.socket, { type: "ERROR", message });
    }
}

function loadLastFmClient(): LastFmClient | null {
    const apiKey = process.env.LASTFM_API_KEY;
    const apiSecret = process.env.LASTFM_API_SECRET;
    const sessionKey = process.env.LASTFM_SESSION_KEY;
    if (!apiKey || !apiSecret || !sessionKey) {
        console.log("Last.fm integration disabled (incomplete .env.local configuration)");
        return null;
    }

    console.log("Last.fm integration enabled");
    return new LastFmClient({ apiKey, apiSecret, sessionKey });
}

function startManager(): void {
    const arRpc = new ArRpcBridge();
    const manager = new PlayerManager(arRpc, loadLastFmClient());
    const controlWss = new WebSocketServer({
        host: CONTROL_WS_HOST,
        port: CONTROL_WS_PORT,
    });
    const arRpcWss = new WebSocketServer({
        host: ARRPC_WS_HOST,
        port: ARRPC_WS_PORT,
    });

    controlWss.on("connection", (socket) => manager.addClient(socket));
    arRpcWss.on("connection", (socket) => arRpc.addClient(socket));

    controlWss.on("listening", () => {
        console.log(`Control WebSocket listening on ws://${CONTROL_WS_HOST}:${CONTROL_WS_PORT}`);
    });
    arRpcWss.on("listening", () => {
        console.log(`arRPC WebSocket listening on ws://${ARRPC_WS_HOST}:${ARRPC_WS_PORT}`);
    });
    controlWss.on("error", (error) =>
        console.error("Control WebSocket server error:", error),
    );
    arRpcWss.on("error", (error) =>
        console.error("arRPC WebSocket server error:", error),
    );

    const shutdown = (): void => {
        manager.closeClients();
        arRpc.closeClients();
        controlWss.close();
        arRpcWss.close();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command === "auth") {
        await authorizeLastFm();
        return;
    }
    if (command) throw new Error(`Unknown command: ${command}`);

    startManager();
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
