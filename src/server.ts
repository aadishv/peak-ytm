import { Value } from "@sinclair/typebox/value";
import html from "../index.html";
import {
    ArtworkRelayRequestSchema,
    CommandMessageSchema,
    LyricsResponseSchema,
    MediaStateSchema,
    StreamMessageSchema,
    YtmLyricsRelayRequestSchema,
    type ArtworkRelayRequest,
    type CommandSymbol,
    type MediaState,
} from "./schemas";
import { Type } from "@sinclair/typebox";

type ArtworkCacheEntry = {
    artworkData: string;
    artworkMimeType: string;
    artworkUrl: string;
};

class PlaybackManager {
    stream: Bun.Subprocess<"pipe", "pipe", "pipe">;
    state: MediaState;
    cacheFile: Bun.BunFile;
    artworkCache: Map<string, ArtworkCacheEntry>;
    lyricsManager: LyricsManager;
    // in flight artwork requests; once the promises are completed, they "feed" into artworkCache
    artworkRequests: Map<string, Promise<void>>;

    private getAdapterPath(): string[] {
        return [
            "/usr/bin/perl",
            "/opt/homebrew/opt/media-control/lib/media-control/mediaremote-adapter.pl",
            "/opt/homebrew/opt/media-control/Frameworks/MediaRemoteAdapter.framework",
        ];
    }

    static getTrackKey(state: Pick<MediaState, "title" | "artist" | "album">) {
        if (!state.title) return null;
        return `${state.title}::${state.artist ?? ""}`;
    }

    private getPublicState(state: MediaState): MediaState {
        const trackKey = PlaybackManager.getTrackKey(state);
        const artwork = trackKey ? this.artworkCache.get(trackKey) : null;
        if (!artwork) return state;
        return {
            ...state,
            artworkData: artwork.artworkData,
            artworkMimeType: artwork.artworkMimeType,
        };
    }

    getSnapshot() {
        return this.getPublicState(this.state);
    }

    private publishState() {
        void this.lyricsManager.handleMediaState(this.getSnapshot());
        server.publish("state", JSON.stringify(this.getSnapshot()));
    }

    private async handleNewMessage(message: MediaState, diff: boolean) {
        if (!diff) {
            this.state = message;
        } else {
            this.state = { ...this.state, ...message };
        }
        this.publishState();
    }

    private async fetchArtwork(artworkUrl: string) {
        const response = await fetch(artworkUrl);
        if (!response.ok) {
            throw new Error(`Artwork fetch failed with ${response.status}`);
        }

        const bytes = await response.arrayBuffer();
        const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
        return {
            artworkData: Buffer.from(bytes).toString("base64"),
            artworkMimeType: mimeType || "image/jpeg",
            artworkUrl,
        } satisfies ArtworkCacheEntry;
    }

    async relayArtwork(payload: ArtworkRelayRequest) {
        const trackKey = PlaybackManager.getTrackKey(payload);
        if (!trackKey) {
            throw new Error("Missing track key");
        }

        const cached = this.artworkCache.get(trackKey);
        if (cached?.artworkUrl === payload.artworkUrl) {
            if (PlaybackManager.getTrackKey(this.state) === trackKey) {
                this.publishState();
            }
            return;
        }

        const existingRequest = this.artworkRequests.get(trackKey);
        if (existingRequest) {
            await existingRequest;
            const refreshed = this.artworkCache.get(trackKey);
            if (refreshed?.artworkUrl === payload.artworkUrl) {
                return;
            }
        }

        const request = (async () => {
            const artwork = await this.fetchArtwork(payload.artworkUrl);
            this.artworkCache.set(trackKey, artwork);
            if (PlaybackManager.getTrackKey(this.state) === trackKey) {
                this.publishState();
            }
        })();

        this.artworkRequests.set(trackKey, request);
        try {
            await request;
        } finally {
            this.artworkRequests.delete(trackKey);
        }
    }

    async watchStream() {
        setInterval(() => {
            void (async () => {
                this.forceRefresh();
            })();
        }, 2000);

        const parseLine = async (line: string) => {
            try {
                const json = JSON.parse(line);
                const streamLine = Value.Parse(StreamMessageSchema, json);
                if (streamLine.type !== "data") return;
                await this.handleNewMessage(streamLine.payload, streamLine.diff);
            } catch {}
        };

        const reader = this.stream.stdout.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            text += decoder.decode(value);

            const lastNewline = text.lastIndexOf("\n");
            const newlyFinishedLines = text.slice(0, lastNewline);
            text = text.slice(lastNewline);

            if (newlyFinishedLines) {
                for (const line of newlyFinishedLines.split("\n")) {
                    await parseLine(line);
                }
            }
        }

        await parseLine(text);
    }

    async forceRefresh() {
        const proc = Bun.spawn([...this.getAdapterPath(), "get", "--micros"]);
        await proc.exited;
        const text = await new Response(proc.stdout).text();
        try {
            const json = JSON.parse(text);
            const message = Value.Parse(MediaStateSchema, json);
            await this.handleNewMessage(message, false);
        } catch {}
    }

    async seek(position: number) {
        const proc = Bun.spawn([
            ...this.getAdapterPath(),
            "seek",
            (position * 1000_000).toFixed(0),
        ]);
        await proc.exited;
        await this.forceRefresh();
    }

    private getCommandId(command: CommandSymbol) {
        switch (command) {
            case "<":
                return 5; // kMRPreviousTrack
            case "_":
                return 2; // kMRTogglePlayPause
            case ">":
                return 4; // kMRNextTrack
            case "<<":
                return 10; // kMRStartBackwardSeek
            case "|<<":
                return 11; // kMREndBackwardSeek
            case ">>":
                return 8; // kMRStartForwardSeek
            case "|>>":
                return 9; // kMREndForwardSeek
        }
    }

    async control(command: CommandSymbol) {
        const proc = Bun.spawn([
            ...this.getAdapterPath(),
            "send",
            `${this.getCommandId(command)}`,
        ]);
        await proc.exited;
        await this.forceRefresh();
    }

    constructor(lyrics: LyricsManager) {
        this.stream = Bun.spawn([
            ...this.getAdapterPath(),
            "stream",
            "--debounce=80",
            "--micros",
        ]);
        this.state = {};
        this.cacheFile = Bun.file("./cache.json");
        this.artworkCache = new Map();
        this.artworkRequests = new Map();
        this.lyricsManager = lyrics;
    }
}

export class LyricsManager {
    cache: Bun.BunFile;
    // in progress LRCLIB fetches
    fetches: Map<string, Promise<void>>;

    constructor() {
        this.cache = Bun.file("./lyrics.json");
        this.fetches = new Map();
    }

    async setLyrics(trackKey: string, lyrics: string, updateCache: boolean = true): Promise<void> {
        if (updateCache) {
            const cache = await this.cache.json();
            cache[trackKey] = lyrics;
            await this.cache.write(JSON.stringify(cache));
        }
        server.publish("lyrics", JSON.stringify({ trackKey, lyrics }));
    }

    async handleMediaState(state: MediaState): Promise<void> {
        const cache = await this.cache.json();
        const trackKey = PlaybackManager.getTrackKey(state);
        if (!trackKey) return;
        try {
            const lyrics = Value.Parse(Type.String(), cache[trackKey]);
            await this.setLyrics(trackKey, lyrics, false);
            return
        }
        catch {
            // no cached lyrics
        }

        if (this.fetches.has(trackKey)) { // already an lrclib check in progress
            return;
        }

        try {
            const lrcMisses = Value.Parse(Type.Array(Type.String()), cache["lrcMisses"] ?? []);
            if (lrcMisses.includes(trackKey)) return;
        }
        catch {
            // invalid lrcMisses, treat as empty
        }

        const fetchPromise = (async () => {
            const params = new URLSearchParams({
                track_name: state.title!,
                artist_name: state.artist!,
                album_name: state.album!,
                duration: String(Math.round((state.durationMicros ?? 0) / 1_000_000)),
            });

            const response = await fetch(`https://lrclib.net/api/get?${params}`, {
                headers: {
                    accept: "application/json",
                },
            });

            try {
                const payload = await response.json();
                const parsed = Value.Parse(LyricsResponseSchema, payload);
                if (!parsed.syncedLyrics) throw new Error();
                await this.setLyrics(trackKey, parsed.syncedLyrics);
            } catch (e) {
                const cache = await this.cache.json();
                cache["lrcMisses"] = [...(cache["lrcMisses"] ?? []), trackKey];
                await this.cache.write(JSON.stringify(cache));
                return;
            }
        })();

        this.fetches.set(trackKey, fetchPromise);
        try {
            await fetchPromise;
        } finally {
            this.fetches.delete(trackKey);
        }
    }
}

const allowedRelayOrigins = new Set([
    "https://music.youtube.com",
    "https://www.youtube.com",
]);

function getRelayCorsHeaders(origin: string | null) {
    return {
        "access-control-allow-origin": origin && allowedRelayOrigins.has(origin)
            ? origin
            : "https://music.youtube.com",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "origin",
    } as const;
}

const lyrics = new LyricsManager();
const manager = new PlaybackManager(lyrics);
await manager.forceRefresh();

const server = Bun.serve({
    port: 1234,
    routes: {
        "/": html,
        "/ws": async (req, serverInstance) => {
            const success = serverInstance.upgrade(req);
            return success
                ? undefined
                : new Response("WebSocket upgrade error", { status: 400 });
        },
        "/api/ytm-artwork": async (req) => {
            const corsHeaders = getRelayCorsHeaders(req.headers.get("origin"));

            if (req.method === "OPTIONS") {
                return new Response(null, { headers: corsHeaders });
            }

            if (req.method !== "POST") {
                return new Response("Method Not Allowed", {
                    status: 405,
                    headers: corsHeaders,
                });
            }

            try {
                const json = await req.json();
                const payload = Value.Parse(ArtworkRelayRequestSchema, json);
                await manager.relayArtwork(payload);
                return Response.json({ ok: true }, { headers: corsHeaders });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "Invalid artwork relay request";
                return Response.json(
                    { ok: false, error: message },
                    { status: 400, headers: corsHeaders },
                );
            }
        },
        "/api/ytm-lyrics": async (req) => {
            const corsHeaders = getRelayCorsHeaders(req.headers.get("origin"));

            if (req.method === "OPTIONS") {
                return new Response(null, { headers: corsHeaders });
            }

            if (req.method !== "POST") {
                return new Response("Method Not Allowed", {
                    status: 405,
                    headers: corsHeaders,
                });
            }

            try {
                const json = await req.json();
                const payload = Value.Parse(YtmLyricsRelayRequestSchema, json);
                const trackKey = PlaybackManager.getTrackKey(manager.state);

                if (!trackKey) {
                    throw new Error("No active track");
                }

                await lyrics.setLyrics(trackKey, payload.lrc);
                return Response.json({ ok: true }, { headers: corsHeaders });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "Invalid YTM lyrics relay request";
                return Response.json(
                    { ok: false, error: message },
                    { status: 400, headers: corsHeaders },
                );
            }
        },
    },
    websocket: {
        open(ws) {
            ws.subscribe("state");
            ws.subscribe("lyrics");
            ws.send(JSON.stringify(manager.getSnapshot()));
        },
        message(_, msg) {
            let contents: string;
            if (typeof msg === "string") {
                contents = msg;
            } else {
                contents = msg.toString();
            }
            try {
                const json = JSON.parse(contents);
                const command = Value.Parse(CommandMessageSchema, json);
                if (command.type === "seek") {
                    manager.seek(command.position);
                } else if (command.type === "command") {
                    manager.control(command.command);
                }
            } catch (e) {
                console.error(e);
            }
        },
        close(ws) {
            ws.unsubscribe("state");
            ws.unsubscribe("lyrics");
        },
    },
});

console.log(`Listening on http://${server.hostname}:${server.port}`);

await Promise.all([server, manager.watchStream()]);
