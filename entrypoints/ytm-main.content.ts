import type {
    LyricsPayload,
    LyricsTranslationLine,
    PlaybackUpdate,
    SongUpdate,
} from "../shared/protocol";

// videoId is the single identity key that joins a song to its lyrics.
type YtmTrack = {
    videoId: string | null;
    title: string | null;
    artist: string | null;
    album: string | null;
    artworkUrl: string | null;
    durationMs: number | null;
};
type CachedTrackMetadata = Omit<YtmTrack, "videoId">;

/**
 * Relays events to (and commands from) the isolated content script over
 * window.postMessage. This is the only class that talks to the page bridge.
 */
class MessageBridge {
    private static readonly OUTBOUND_SOURCE = "ytm-main";
    private static readonly INBOUND_SOURCE = "ytm-isolated";

    private post(type: string, payload: unknown): void {
        window.postMessage(
            { source: MessageBridge.OUTBOUND_SOURCE, type, payload },
            "*",
        );
    }

    emitSong(song: SongUpdate): void {
        this.post("SONG_UPDATE", song);
    }

    emitPlayback(playback: PlaybackUpdate): void {
        this.post("PLAYBACK_UPDATE", playback);
    }

    emitLyrics(videoId: string, lyrics: LyricsPayload): void {
        this.post("LYRICS_UPDATE", { videoId, lyrics });
    }

    onMessage(handler: (type: string, payload: any) => void): void {
        window.addEventListener("message", (event) => {
            if (!event.data || event.data.source !== MessageBridge.INBOUND_SOURCE) {
                return;
            }
            handler(event.data.type, event.data.payload);
        });
    }
}

/**
 * Reads track metadata straight out of the in-page YouTube Music app: the
 * player API, the playback queue, and the thumbnail catalog. Owns the metadata
 * cache keyed by videoId.
 */
class YtmClient {
    private static readonly ALBUM_PAGE_TYPE = "MUSIC_PAGE_TYPE_ALBUM";
    private static readonly AUDIO_TRACK_TYPE = "MUSIC_VIDEO_TYPE_ATV";

    private readonly trackCache = new Map<string, CachedTrackMetadata>();

    private get app(): any {
        return document.querySelector("ytmusic-app");
    }

    getTrack(): YtmTrack {
        const api = this.app?.playerApi;
        const details =
            api?.getPlayerResponse?.()?.videoDetails ??
            api?.getVideoData?.() ??
            {};

        const videoId = details.videoId ?? details.video_id ?? null;
        if (!videoId) {
            return {
                videoId: null,
                title: null,
                artist: null,
                album: null,
                artworkUrl: null,
                durationMs: null,
            };
        }

        const cached = this.trackCache.get(videoId);

        const album =
            cached?.album !== null && cached?.album !== undefined
                ? cached.album
                : this.getQueueAlbum(videoId);

        let artworkUrl = cached?.artworkUrl ?? null;
        if (!artworkUrl) {
            const thumbnails = details?.thumbnail?.thumbnails ?? [];
            artworkUrl =
                [...thumbnails]
                    .filter((thumbnail: any) => thumbnail?.url)
                    .sort(
                        (a: any, b: any) => (b.width ?? 0) - (a.width ?? 0),
                    )[0]?.url ?? null;
        }

        if (details.title === "") {
            details.title = null;
        }
        if (details.author === "") {
            details.author = null;
        }

        const metadata: CachedTrackMetadata = {
            title: cached?.title ?? details.title ?? null,
            artist: cached?.artist ?? details.author ?? null,
            album,
            artworkUrl,
            durationMs:
                cached?.durationMs ??
                (Number(api?.getDuration?.()) * 1000 || null),
        };
        this.trackCache.set(videoId, metadata);

        return { videoId, ...metadata };
    }

    getVideoId(): string {
        return this.getTrack().videoId ?? "";
    }

    watchTrack(callback: (track: YtmTrack) => void): (() => void) | null {
        const app = this.app;
        const api = app?.playerApi;
        const store = app?.playerUiService?.store?.store;
        if (!api?.addEventListener || !store?.subscribe) return null;

        let previous = "";
        const publish = () => {
            const track = this.getTrack();
            const fingerprint = JSON.stringify(track);
            if (fingerprint === previous) return;
            previous = fingerprint;
            callback(track);
        };
        const onVideoDataChange = (name: string) => {
            if (["newdata", "dataloaded", "dataupdated"].includes(name)) {
                setTimeout(publish, 0);
            }
        };

        api.addEventListener("videodatachange", onVideoDataChange);
        const unsubscribe = store.subscribe(publish);
        publish();

        return () => {
            api.removeEventListener("videodatachange", onVideoDataChange);
            unsubscribe();
        };
    }

    /** Merge a resolved catalog album back into the cache for this track. */
    rememberAlbum(track: YtmTrack, album: string): void {
        const videoId = track.videoId;
        if (!videoId) return;

        const cached = this.trackCache.get(videoId) ?? {
            title: track.title,
            artist: track.artist,
            album: null,
            artworkUrl: track.artworkUrl,
            durationMs: track.durationMs,
        };
        this.trackCache.set(videoId, { ...cached, album });
    }

    /** Album name as it appears in the in-page queue, or null when absent. */
    getQueueAlbum(videoId: string): string | null {
        const bundle = this.getQueueTrackBundle(videoId);
        for (const renderer of bundle?.renderers ?? []) {
            const albumRun = renderer?.longBylineText?.runs?.find(
                (run: any) =>
                    run?.navigationEndpoint?.browseEndpoint
                        ?.browseEndpointContextSupportedConfigs
                        ?.browseEndpointContextMusicConfig?.pageType ===
                    YtmClient.ALBUM_PAGE_TYPE,
            );
            if (albumRun) return String(albumRun.text ?? "");
        }

        return null;
    }

    /**
     * Official videos can have an audio-track counterpart carrying the catalog
     * album even when the video's own response has no album.
     */
    getCatalogCounterpartVideoId(videoId: string): string | null {
        const bundle = this.getQueueTrackBundle(videoId);
        const renderer = bundle?.renderers.find(
            (candidate: any) =>
                candidate?.videoId !== videoId &&
                candidate?.navigationEndpoint?.watchEndpoint
                    ?.watchEndpointMusicSupportedConfigs
                    ?.watchEndpointMusicConfig?.musicVideoType ===
                    YtmClient.AUDIO_TRACK_TYPE,
        );
        return renderer?.videoId ?? null;
    }

    private getQueueTrackBundle(videoId: string): { renderers: any[] } | null {
        const queue = this.app?.queue;
        const items = queue?.getItems?.() ?? [];
        const currentItem = items[queue?.getCurrentItemIndex?.()];
        const orderedItems = [
            currentItem,
            ...items.filter((item: any) => item !== currentItem),
        ];

        for (const item of orderedItems) {
            const wrapper = item?.playlistPanelVideoWrapperRenderer;
            const primary =
                item?.playlistPanelVideoRenderer ??
                wrapper?.primaryRenderer?.playlistPanelVideoRenderer;
            const counterparts =
                wrapper?.counterpart
                    ?.map(
                        (entry: any) =>
                            entry?.counterpartRenderer
                                ?.playlistPanelVideoRenderer,
                    )
                    .filter(Boolean) ?? [];
            const renderers = [primary, ...counterparts].filter(Boolean);

            if (
                renderers.some(
                    (renderer: any) => renderer?.videoId === videoId,
                )
            ) {
                return { renderers };
            }
        }

        return null;
    }
}

/**
 * Talks to YouTube's InnerTube API (browse/next endpoints) to resolve the
 * catalog album and timed lyrics for a track. Depends on YtmClient for the
 * queue-based album hints.
 */
class InnerTubeClient {
    constructor(private readonly ytm: YtmClient) {}

    async fetchTrackContext(
        videoId: string,
    ): Promise<{ lyricsBrowseId: string | null; album: string }> {
        const nextResponse = await this.request("next", {
            context: this.musicContext(),
            videoId,
            enablePersistentPlaylistPanel: true,
            isAudioOnly: true,
        });

        let album =
            this.ytm.getQueueAlbum(videoId) ??
            InnerTubeClient.getAlbumFromNextResponse(nextResponse);

        const counterpartVideoId =
            this.ytm.getCatalogCounterpartVideoId(videoId);
        if (album === "" && counterpartVideoId) {
            const counterpartResponse = await this.request("next", {
                context: this.musicContext(),
                videoId: counterpartVideoId,
                enablePersistentPlaylistPanel: true,
                isAudioOnly: true,
            });
            album = InnerTubeClient.getAlbumFromNextResponse(counterpartResponse);
        }

        if (album === null) {
            throw new Error(`Album metadata is still pending for ${videoId}`);
        }

        return {
            lyricsBrowseId: InnerTubeClient.getLyricsBrowseId(nextResponse),
            album,
        };
    }

    async fetchLyrics(
        browseId: string,
        targetLanguage = "en",
    ): Promise<LyricsPayload | null> {
        const data = await this.browse({
            context: this.mobileBrowseContext(),
            browseId,
        });
        const timedLyricsData =
            data?.contents?.elementRenderer?.newElement?.type?.componentType
                ?.model?.timedLyricsModel?.lyricsData?.timedLyricsData;

        (window as any).__ytmLyricsDebug = {
            browseId,
            source: data,
            translation: null,
        };

        if (!Array.isArray(timedLyricsData) || timedLyricsData.length === 0) {
            return null;
        }

        const translationTokenRaw = InnerTubeClient.findNestedValue(
            data,
            "translationContinuationToken",
        );

        let translations: LyricsTranslationLine[] = [];
        if (typeof translationTokenRaw === "string" && translationTokenRaw) {
            const translationData = await this.browse({
                context: this.mobileBrowseContext(targetLanguage),
                continuation: decodeURIComponent(translationTokenRaw),
            });

            (window as any).__ytmLyricsDebug.translation = translationData;

            const translatedLines =
                translationData?.continuationContents?.musicLyricsContinuation
                    ?.lyricsTranslations;

            if (Array.isArray(translatedLines)) {
                translations = translatedLines.map((line: any, index: number) => ({
                    startTimeMs: Number(
                        timedLyricsData[index]?.cueRange
                            ?.startTimeMilliseconds ?? 0,
                    ),
                    text:
                        typeof line?.translatedLyricText === "string"
                            ? line.translatedLyricText
                            : "",
                }));
            }
        }

        return {
            lrc: InnerTubeClient.toLrc(timedLyricsData),
            translations,
            translationLanguage: translations.length > 0 ? targetLanguage : null,
        };
    }

    private async request(
        endpoint: "browse" | "next",
        body: Record<string, unknown>,
    ): Promise<any> {
        const apiKey = (window as any).ytcfg?.get?.("INNERTUBE_API_KEY");
        if (!apiKey) throw new Error("Missing INNERTUBE_API_KEY");

        const response = await fetch(
            `/youtubei/v1/${endpoint}?prettyPrint=false&key=${encodeURIComponent(apiKey)}`,
            {
                method: "POST",
                credentials: "same-origin",
                headers: this.headers(),
                body: JSON.stringify(body),
            },
        );

        if (!response.ok) {
            throw new Error(`Music ${endpoint} request failed with ${response.status}`);
        }

        return response.json();
    }

    private browse(body: Record<string, unknown>): Promise<any> {
        return this.request("browse", body);
    }

    private headers(): Record<string, string> {
        const cfg = (window as any).ytcfg;
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-origin": window.location.origin,
            "x-youtube-bootstrap-logged-in": String(
                Number(!!cfg?.get?.("LOGGED_IN")),
            ),
        };

        const authUser = cfg?.get?.("SESSION_INDEX");
        const visitorData = cfg?.get?.("VISITOR_DATA");
        const clientName = cfg?.get?.("INNERTUBE_CONTEXT_CLIENT_NAME");
        const clientVersion = cfg?.get?.("INNERTUBE_CLIENT_VERSION");

        if (authUser != null) headers["x-goog-authuser"] = String(authUser);
        if (visitorData) headers["x-goog-visitor-id"] = String(visitorData);
        if (clientName != null)
            headers["x-youtube-client-name"] = String(clientName);
        if (clientVersion)
            headers["x-youtube-client-version"] = String(clientVersion);

        return headers;
    }

    private musicContext(): any {
        const context = (window as any).ytcfg?.get?.("INNERTUBE_CONTEXT");
        if (!context) throw new Error("Missing INNERTUBE_CONTEXT");
        return InnerTubeClient.cloneValue(context);
    }

    private mobileBrowseContext(targetLanguage?: string): any {
        const context = this.musicContext();
        context.client.clientName = "ANDROID_MUSIC";
        context.client.clientVersion = "9.24.51";
        if (targetLanguage) {
            context.client.hl = targetLanguage;
        }
        return context;
    }

    private static cloneValue<T>(value: T): T {
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    private static getLyricsBrowseId(nextResponse: any): string | null {
        const tabs =
            nextResponse?.contents?.singleColumnMusicWatchNextResultsRenderer
                ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? [];

        const lyricsTab = tabs.find(
            (tab: any) =>
                tab?.tabRenderer?.endpoint?.browseEndpoint
                    ?.browseEndpointContextSupportedConfigs
                    ?.browseEndpointContextMusicConfig?.pageType ===
                "MUSIC_PAGE_TYPE_TRACK_LYRICS",
        );

        return (
            lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId ?? null
        );
    }

    private static getAlbumFromNextResponse(nextResponse: any): string | null {
        const renderer =
            nextResponse?.playerOverlays?.playerOverlayRenderer
                ?.browserMediaSession?.browserMediaSessionRenderer;
        if (!renderer) return null;
        if (!Object.hasOwn(renderer, "album")) return "";

        return (
            renderer.album?.runs
                ?.map((run: any) => run?.text ?? "")
                .join("") ?? ""
        );
    }

    private static findNestedValue(value: unknown, key: string): unknown {
        let result: unknown;

        const visit = (current: unknown) => {
            if (!current || typeof current !== "object" || result !== undefined) {
                return;
            }

            for (const [currentKey, currentValue] of Object.entries(current)) {
                if (currentKey === key) {
                    result = currentValue;
                    return;
                }
                visit(currentValue);
                if (result !== undefined) {
                    return;
                }
            }
        };

        visit(value);
        return result;
    }

    private static toLrc(timedLyricsData: any[]): string {
        const lines = [];

        for (const line of timedLyricsData) {
            const startMs = line?.cueRange?.startTimeMilliseconds;
            if (startMs == null) continue;

            const timestamp = InnerTubeClient.formatLrcTimestamp(startMs);
            const text =
                typeof line?.lyricLine === "string" ? line.lyricLine : "";
            const segments = text.replace(/\r/g, "").split("\n");

            for (const segment of segments) {
                lines.push(`[${timestamp}]${segment}`);
            }
        }

        return lines.join("\n");
    }

    private static formatLrcTimestamp(milliseconds: number): string {
        const totalMs = Math.max(0, Number(milliseconds) || 0);
        const minutes = Math.floor(totalMs / 60_000);
        const seconds = Math.floor(totalMs / 1_000) % 60;
        const centiseconds = Math.floor((totalMs % 1_000) / 10);
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
    }
}

/**
 * Owns the <video> element and progress bar: emits playback updates, mirrors
 * transport controls, and dedupes redundant emissions.
 */
class PlaybackTracker {
    private videoElement: HTMLVideoElement | null = null;
    private progressBarElement: Element | null = null;
    private waitingForTrackStart = false;
    private lastPlaybackKey = "";

    constructor(private readonly bridge: MessageBridge) {}

    /** Attach listeners to the current <video> and progress bar if present. */
    attach(): void {
        const video = document.querySelector("video");
        if (video instanceof HTMLVideoElement) {
            this.setupVideoListeners(video);
        }

        const progressBar = document.querySelector("#progress-bar");
        if (progressBar) {
            this.setupProgressBarObserver(progressBar);
        }
    }

    /**
     * YouTube briefly pairs new metadata with the previous track's position
     * while changing tracks; skip emissions until the new position starts.
     */
    expectTrackStart(): void {
        this.waitingForTrackStart = true;
    }

    emit(force = false): void {
        const video = this.videoElement ?? document.querySelector("video");
        if (!(video instanceof HTMLVideoElement)) return;

        this.videoElement = video;
        const progressBar =
            this.progressBarElement ?? document.querySelector("#progress-bar");
        if (progressBar) this.progressBarElement = progressBar;

        const elapsedSeconds = Math.max(
            0,
            PlaybackTracker.readNumericValue(progressBar),
        );

        const payload: PlaybackUpdate = {
            paused: video.paused,
            elapsedTimeMicros: Math.round(elapsedSeconds * 1_000_000),
            timestampEpochMicros: Date.now() * 1000,
        };

        if (this.waitingForTrackStart) {
            if (payload.elapsedTimeMicros > 1_000_000) return;
            this.waitingForTrackStart = false;
        }

        const nextKey = `${payload.paused ? "1" : "0"}:${payload.elapsedTimeMicros}`;
        if (!force && nextKey === this.lastPlaybackKey) return;
        this.lastPlaybackKey = nextKey;
        this.bridge.emitPlayback(payload);
    }

    togglePlay(): void {
        const video = this.getVideo();
        if (!video) return;

        if (video.paused) {
            video.play().catch(() => {
                const playBtn =
                    document.querySelector<HTMLElement>("#play-pause-button") ||
                    document.querySelector<HTMLElement>(".play-pause-button");
                playBtn?.click();
            });
        } else {
            video.pause();
        }
    }

    previous(): void {
        const prevBtn =
            document.getElementById("previous-button") ||
            document.querySelector<HTMLElement>(".previous-button") ||
            document.querySelector<HTMLElement>(
                'button[aria-label="Previous track"]',
            );
        prevBtn?.click();
    }

    next(): void {
        const nextBtn =
            document.getElementById("next-button") ||
            document.querySelector<HTMLElement>(".next-button") ||
            document.querySelector<HTMLElement>(
                'button[aria-label="Next track"]',
            );
        nextBtn?.click();
    }

    seek(position: number): void {
        const video = this.getVideo();
        if (video && Number.isFinite(position)) {
            video.currentTime = position;
        }
    }

    private getVideo(): HTMLVideoElement | null {
        const video = this.videoElement ?? document.querySelector("video");
        return video instanceof HTMLVideoElement ? video : null;
    }

    private setupVideoListeners(video: HTMLVideoElement): void {
        if (
            (video as { __ytmMainListenersInstalled?: boolean })
                .__ytmMainListenersInstalled
        ) {
            return;
        }

        (video as { __ytmMainListenersInstalled?: boolean }).__ytmMainListenersInstalled = true;
        this.videoElement = video;

        const events = [
            "play",
            "pause",
            "ratechange",
            "loadedmetadata",
            "durationchange",
            "seeking",
            "seeked",
            "emptied",
            "ended",
        ] as const;

        for (const eventName of events) {
            video.addEventListener(eventName, () => this.emit(true));
        }
    }

    private setupProgressBarObserver(progressBar: Element): void {
        if ((progressBar as { __ytmProgressObserverInstalled?: boolean }).__ytmProgressObserverInstalled) {
            return;
        }

        (progressBar as { __ytmProgressObserverInstalled?: boolean }).__ytmProgressObserverInstalled = true;
        this.progressBarElement = progressBar;

        const observer = new MutationObserver(() => {
            this.emit(true);
        });

        observer.observe(progressBar, {
            attributes: true,
            attributeFilter: ["value", "aria-valuenow", "max", "aria-valuemax"],
        });
    }

    private static readNumericValue(element: Element | null): number {
        if (!element) return 0;

        const valueFromProperty = (element as HTMLInputElement).value;
        const valueFromAttribute = element.getAttribute("value");
        const valueFromAria = element.getAttribute("aria-valuenow");
        const numeric = Number(
            valueFromProperty ?? valueFromAttribute ?? valueFromAria ?? 0,
        );

        return Number.isFinite(numeric) ? numeric : 0;
    }
}

/**
 * Coordinates the pieces: watches for track changes, publishes song/lyrics
 * updates, resolves catalog metadata, and routes incoming transport commands.
 */
class YtmMainController {
    // videoId is the identity key that joins song and lyrics together.
    private currentVideoId = "";
    private currentSongKey = "";
    private lastFetchedVideoId = "";
    private inFlightLyricsVideoId = "";
    private stopWatchingTrack: (() => void) | null = null;

    constructor(
        private readonly ytm: YtmClient,
        private readonly innertube: InnerTubeClient,
        private readonly playback: PlaybackTracker,
        private readonly bridge: MessageBridge,
    ) {}

    start(): void {
        const pageObserver = new MutationObserver(() => {
            this.attachObservers();
        });
        pageObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        this.attachObservers();

        this.bridge.onMessage((type, payload) =>
            this.handleCommand(type, payload),
        );

        setInterval(() => {
            if (!this.stopWatchingTrack) this.attachObservers();
            const track = this.ytm.getTrack();
            if (track.videoId) void this.checkAndUpdate(track);
            this.playback.emit(true);
        }, 1500);
    }

    private attachObservers(): void {
        this.playback.attach();

        if (!this.stopWatchingTrack) {
            // watchTrack publishes synchronously, so guard against its callback
            // re-entering this setup before it returns.
            this.stopWatchingTrack = () => {};
            this.stopWatchingTrack = this.ytm.watchTrack((track) => {
                this.attachObservers();
                void this.checkAndUpdate(track);
                this.playback.emit(true);
            });
        }
    }

    private handleCommand(type: string, payload: any): void {
        if (type === "COMMAND") {
            const command = payload?.command;
            if (command === "_") this.playback.togglePlay();
            else if (command === "<") this.playback.previous();
            else if (command === ">") this.playback.next();
        } else if (type === "SEEK") {
            this.playback.seek(Number(payload?.position));
        }
    }

    private async checkAndUpdate(track: YtmTrack): Promise<void> {
        const { title, artist, album, artworkUrl } = track;
        const videoId = track.videoId ?? "";
        if (!videoId) return;

        const trackChanged = videoId !== this.currentVideoId;
        if (trackChanged) {
            this.currentVideoId = videoId;
            this.currentSongKey = "";
            this.lastFetchedVideoId = "";
            this.inFlightLyricsVideoId = "";
            this.playback.expectTrackStart();
        }

        const durationMicros = Math.round((track.durationMs ?? 0) * 1000);
        const songKey = `${videoId}::${title}::${artist}::${album ?? "<pending>"}::${artworkUrl}::${durationMicros}`;

        if (
            album != null &&
            title != null &&
            artist != null &&
            songKey !== this.currentSongKey
        ) {
            this.currentSongKey = songKey;
            this.bridge.emitSong({
                videoId,
                title,
                artist,
                album,
                artworkUrl,
                durationMicros,
            });

            if (!trackChanged) this.playback.emit(true);
        }

        if (
            videoId === this.lastFetchedVideoId ||
            videoId === this.inFlightLyricsVideoId
        ) {
            return;
        }

        this.inFlightLyricsVideoId = videoId;
        try {
            // Resolve the lyrics endpoint from a watch-next request for this
            // exact video. The player page's tabs can still belong to the
            // previous track while YouTube Music is changing songs.
            const trackContext = await this.innertube.fetchTrackContext(videoId);
            if (this.currentVideoId !== videoId || this.ytm.getVideoId() !== videoId) {
                return;
            }

            this.ytm.rememberAlbum(track, trackContext.album);

            // Publish immediately from the completed response instead of
            // waiting for YTM to copy the album into its delayed overlay.
            await this.checkAndUpdate(this.ytm.getTrack());

            const lyricsBrowseId = trackContext.lyricsBrowseId;
            if (!lyricsBrowseId) {
                this.lastFetchedVideoId = videoId;
                return;
            }

            const lyrics = await this.innertube.fetchLyrics(lyricsBrowseId);
            if (this.currentVideoId !== videoId || this.ytm.getVideoId() !== videoId) {
                return;
            }

            this.lastFetchedVideoId = videoId;
            if (lyrics) {
                this.bridge.emitLyrics(videoId, lyrics);
            }
        } catch (error) {
            console.error("[YTM-Main] Failed to fetch track context or timed lyrics", error);
        } finally {
            if (this.inFlightLyricsVideoId === videoId) {
                this.inFlightLyricsVideoId = "";
            }
        }
    }
}

export default defineContentScript({
    matches: ["*://music.youtube.com/*"],
    world: "MAIN",
    runAt: "document_start",
    main() {
        const bridge = new MessageBridge();
        const ytm = new YtmClient();
        const innertube = new InnerTubeClient(ytm);
        const playback = new PlaybackTracker(bridge);
        const controller = new YtmMainController(ytm, innertube, playback, bridge);

        controller.start();
    },
});
