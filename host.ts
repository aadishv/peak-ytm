import { WebSocket, WebSocketServer } from "ws";
import {
    HelloMessageSchema,
    PlaybackUpdate,
    SongUpdate,
    type ClientMessage,
    type ClientRole,
    type EventMessage,
    type ServerMessage,
} from "./shared/protocol.ts";
import { createHash } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Value } from "@sinclair/typebox/value";

const ENV_FILE_URL = new URL("./.env.local", import.meta.url);
process.loadEnvFile(ENV_FILE_URL);

class Relay {
    private static readonly CONTROL_WS_HOST = "127.0.0.1";
    private static readonly CONTROL_WS_PORT = Number(
        process.env.YTM_RPC_WS_PORT || 32145,
    );

    private playerClients = new Set<WebSocket>();
    private visualizerClients = new Set<WebSocket>();
    private listeners = new Set<(message: EventMessage) => void>();
    private lastSong: EventMessage | null = null;
    private lastLyrics: EventMessage | null = null;
    private lastPlayback: EventMessage | null = null;

    static sendJson(socket: WebSocket, message: ServerMessage): void {
        if (socket.readyState !== WebSocket.OPEN) return;

        try {
            socket.send(JSON.stringify(message));
        } catch (error) {
            console.error("Failed to send WebSocket message:", error);
        }
    }

    async addClient(socket: WebSocket) {
        socket.on("error", (error) => {
            console.error("Socket error:", error.message);
        });
        await new Promise<void>((resolve) => {
            let assigned = false;
            socket.on("message", (msg) => {
                if (assigned) return;
                const json = JSON.parse(msg.toString("utf8"));
                try {
                    const message = Value.Parse(HelloMessageSchema, json);
                    assigned = true;
                    if (message.role === "player") {
                        this.playerClients.add(socket);
                        socket.on("close", () => {
                            this.playerClients.delete(socket);
                            for (const client of this.playerClients) {
                                Relay.sendJson(client, { type: "CLEAR" });
                            }
                            for (const listener of this.listeners) {
                                listener({ type: "CLEAR" });
                            }
                        });
                        socket.on(
                            "message",
                            this.handlePlayerMessage.bind(this),
                        );
                    } else {
                        this.visualizerClients.add(socket);
                        // replay
                        for (const message of [
                            this.lastSong,
                            this.lastLyrics,
                            this.lastPlayback,
                        ]) {
                            if (message) Relay.sendJson(socket, message);
                        }
                        socket.on("close", () =>
                            this.visualizerClients.delete(socket),
                        );
                        socket.on(
                            "message",
                            this.handleVisualizerMessage.bind(this),
                        );
                    }
                } catch {}
                resolve();
            });
        });
    }

    private handlePlayerMessage(raw: WebSocket.RawData): void {
        let message: ClientMessage;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            return;
        }

        switch (message.type) {
            case "SONG_UPDATE":
            case "LYRICS_UPDATE":
            case "PLAYBACK_UPDATE": {
                if (message.type === "SONG_UPDATE") this.lastSong = message;
                else if (message.type === "LYRICS_UPDATE")
                    this.lastLyrics = message;
                else if (message.type === "PLAYBACK_UPDATE")
                    this.lastPlayback = message;
                for (const visualizer of this.visualizerClients) {
                    Relay.sendJson(visualizer, message);
                }
                for (const listener of this.listeners) {
                    listener(message);
                }
                return;
            }
        }
    }

    private handleVisualizerMessage(raw: WebSocket.RawData): void {
        let message: ClientMessage;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            return;
        }

        switch (message.type) {
            case "COMMAND":
            case "SEEK": {
                for (const player of this.playerClients) {
                    Relay.sendJson(player, message);
                }
                return;
            }
        }
    }

    listen(listener: (message: EventMessage) => void): void {
        this.listeners.add(listener);
    }

    start() {
        const server = new WebSocketServer({
            host: Relay.CONTROL_WS_HOST,
            port: Relay.CONTROL_WS_PORT,
        });
        server.on("connection", (socket) => this.addClient(socket));
        server.on("error", (error) =>
            console.error("Control WebSocket server error:", error),
        );
        const shutdown = (): void => {
            for (const client of this.playerClients) {
                client.close();
            }
            for (const client of this.visualizerClients) {
                client.close();
            }
            server.close();
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
}

type ArrpcActivity = {
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
    buttons?: { label: string; url: string }[];
    flags: number;
    instance?: boolean;
};

class ArrpcBridge {
    private static readonly DISCORD_CLIENT_ID = "1242988484671705208";
    private static readonly ARRPC_WS_HOST = "127.0.0.1";
    private static readonly ARRPC_WS_PORT = Number(
        process.env.YTM_ARRPC_WS_PORT || 1337,
    );
    private static readonly ARRPC_SOCKET_ID = "0";

    private readonly clients = new Set<WebSocket>();
    private state: {
        song: SongUpdate | null;
        playback: PlaybackUpdate | null;
    } = { song: null, playback: null };
    private currentMessage: {
        activity: ArrpcActivity | null;
        pid: number;
        socketId: string;
    } | null = null;
    private lastSignature: string | null = null;
    private lastStartTimestamp: number | null = null;
    private lastEndTimestamp: number | null = null;

    addClient(socket: WebSocket): void {
        this.clients.add(socket);
        if (this.currentMessage)
            socket.send(JSON.stringify(this.currentMessage));

        socket.on("close", () => this.clients.delete(socket));
        socket.on("error", (error) => {
            console.error("arRPC bridge socket error:", error.message);
        });
    }

    listener(message: EventMessage) {
        if (message.type === "PLAYBACK_UPDATE") {
            this.state.playback = message.payload;
        }
        if (message.type === "SONG_UPDATE") {
            this.state.song = message.payload;
        }
        if (message.type === "CLEAR") {
            this.state.song = null;
            this.state.playback = null;
            this.resetRememberedActivity();
        }
        this.broadcast();
    }

    activity(): ArrpcActivity | null {
        const song = this.state.song;
        const playback = this.state.playback;
        if (!song || !playback || playback.paused) return null;

        const startedAtMs = Math.round(
            (playback.timestampEpochMicros - playback.elapsedTimeMicros) /
                1_000,
        );
        const durationMs = Math.round(song.durationMicros / 1_000);

        return {
            application_id: ArrpcBridge.DISCORD_CLIENT_ID,
            name: "YouTube Music",
            type: 2,
            details: song.title,
            state: song.artist,
            timestamps:
                durationMs > 0
                    ? { start: startedAtMs, end: startedAtMs + durationMs }
                    : undefined,
            assets: {
                large_image: song.artworkUrl || undefined,
                large_text: song.album,
            },
            flags: 0,
        };
    }

    private getSignature(activity: ArrpcActivity): string {
        return JSON.stringify({
            application_id: activity.application_id,
            name: activity.name,
            type: activity.type,
            details: activity.details,
            state: activity.state,
            assets: activity.assets,
            metadata: activity.metadata,
            buttons: activity.buttons,
            flags: activity.flags,
            instance: activity.instance,
        });
    }

    private shouldSend(activity: ArrpcActivity): boolean {
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

    private remember(activity: ArrpcActivity): void {
        this.lastSignature = this.getSignature(activity);
        this.lastStartTimestamp = activity.timestamps?.start ?? null;
        this.lastEndTimestamp = activity.timestamps?.end ?? null;
    }

    private resetRememberedActivity(): void {
        this.lastSignature = null;
        this.lastStartTimestamp = null;
        this.lastEndTimestamp = null;
    }

    broadcast() {
        const activity = this.activity();
        if (activity) {
            if (!this.shouldSend(activity)) return;
        } else {
            this.resetRememberedActivity();
        }

        const message = {
            activity,
            pid: process.pid,
            socketId: ArrpcBridge.ARRPC_SOCKET_ID,
        };
        if (JSON.stringify(message) !== JSON.stringify(this.currentMessage)) {
            this.currentMessage = message;
            if (activity) this.remember(activity);
            for (const client of this.clients) {
                client.send(JSON.stringify(message));
            }
        }
    }

    start() {
        const server = new WebSocketServer({
            host: ArrpcBridge.ARRPC_WS_HOST,
            port: ArrpcBridge.ARRPC_WS_PORT,
        });
        server.on("connection", (socket) => this.addClient(socket));
        server.on("error", (error) =>
            console.error("arRPC bridge server error:", error),
        );
        const shutdown = (): void => {
            for (const client of this.clients) {
                client.close();
            }
            server.close();
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
}

class LastFm {
    static readonly BASE_URL = "https://ws.audioscrobbler.com/2.0/";
    readonly apiKey: string;
    readonly apiSecret: string;
    sessionKey: string = "";
    private state: {
        song: SongUpdate | null;
        playback: PlaybackUpdate | null;
    } = { song: null, playback: null };

    constructor() {
        if (!process.env.LAST_FM_API_KEY) {
            throw new Error("LAST_FM_API_KEY not set");
        }
        if (!process.env.LAST_FM_API_SECRET) {
            throw new Error("LAST_FM_API_SECRET not set");
        }
        this.apiKey = process.env.LAST_FM_API_KEY;
        this.apiSecret = process.env.LAST_FM_API_SECRET;
    }

    sign(params: Record<string, string>) {
        const signatureInput = Object.entries(params)
            .filter(([key]) => key !== "format" && key !== "callback")
            .sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
            )
            .map(([key, value]) => `${key}${value}`)
            .join("");

        return createHash("md5")
            .update(signatureInput + this.apiSecret, "utf8")
            .digest("hex");
    }

    private async callAuth(params: Record<string, string>) {
        const wireParams = {
            ...params,
            api_sig: this.sign({ ...params, api_key: this.apiKey }),
            api_key: this.apiKey,
            format: "json",
        };

        const response = await fetch(
            `${LastFm.BASE_URL}?${new URLSearchParams(wireParams)}`,
        );
        const body = (await response.json()) as {
            token?: string;
            session?: { key?: string; name?: string };
            error?: number;
            message?: string;
        };

        if (!response.ok || body.error) {
            throw new Error(
                body.message || `Last.fm returned HTTP ${response.status}`,
            );
        }
        return body;
    }

    async authorize() {
        if (process.env.LAST_FM_SESSION_KEY) {
            this.sessionKey = process.env.LAST_FM_SESSION_KEY;
            return;
        }
        const tokenResponse = await this.callAuth({
            method: "auth.getToken",
        });
        if (!tokenResponse.token)
            throw new Error("Last.fm did not return an auth token");

        const authorizationUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(this.apiKey)}&token=${encodeURIComponent(tokenResponse.token)}`;
        console.log(`Authorize peak ytm at: ${authorizationUrl}`);

        const prompt = createInterface({ input: stdin, output: stdout });
        try {
            await prompt.question("press enter when done...");
        } finally {
            prompt.close();
        }

        const sessionResponse = await this.callAuth({
            method: "auth.getSession",
            token: tokenResponse.token,
        });
        const sessionKey = sessionResponse.session?.key;
        if (!sessionKey)
            throw new Error("Last.fm did not return a session key");

        this.sessionKey = sessionKey;

        console.log(`authed as ${sessionResponse.session?.name}`);
        console.log(`add to .env: LAST_FM_SESSION_KEY=${sessionKey}`);
    }

    private async submit(
        method: "track.updateNowPlaying" | "track.scrobble",
    ): Promise<void> {
        const song = this.state.song;
        const playback = this.state.playback;
        if (!song) {
            return;
        }

        console.log(
            method,
            "for",
            song.title,
            "by",
            song.artist,
            "of",
            song.album,
        );
        const params: Record<string, string> = {
            method,
            api_key: this.apiKey,
            sk: this.sessionKey,
            artist: song.artist,
            track: song.title,
            duration: String(
                Math.max(0, Math.round(song.durationMicros / 1_000_000)),
            ),
        };

        if (playback) {
            params.timestamp = String(
                (playback.timestampEpochMicros - playback.elapsedTimeMicros) /
                    1_000_000,
            );
        }

        params.api_sig = this.sign(params);
        params.format = "json";

        await fetch(LastFm.BASE_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params),
        });
    }

    isScrobblable() {
        if (!this.state.song || !this.state.playback) return false;
        const lengthSongs = this.state.song?.durationMicros / 1_000_000;
        const midway = Math.min(240, lengthSongs / 2);
        return this.state.playback.elapsedTimeMicros / 1_000_000 >= midway;
    }

    listener(message: EventMessage) {
        if (message.type !== "PLAYBACK_UPDATE") {
            console.log(message);
        }
        void (async () => {
            if (message.type === "CLEAR") {
                this.state.song = null;
                this.state.playback = null;
                return;
            } else if (message.type === "SONG_UPDATE") {
                this.state.song = message.payload;
                await this.submit("track.updateNowPlaying");
            } else if (message.type === "PLAYBACK_UPDATE") {
                const wasScrobblablePrev = this.isScrobblable();
                this.state.playback = message.payload;
                if (!wasScrobblablePrev && this.isScrobblable()) {
                    await this.submit("track.scrobble");
                }
            }
        })();
    }
}

const relay = new Relay();
const arrpc = new ArrpcBridge();
const lastFm = new LastFm();
await lastFm.authorize();

relay.listen(arrpc.listener.bind(arrpc));
relay.listen(lastFm.listener.bind(lastFm));

arrpc.start();
relay.start();
