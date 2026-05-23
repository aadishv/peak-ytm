// ==UserScript==
// @name         lyrics.localhost
// @namespace    aadishv.dev
// @version      0.1.0
// @description  Relay synced YouTube Music lyrics to music.localhost with minimal page impact.
// @match        https://music.youtube.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
    "use strict";

    const ENDPOINT = "https://music.localhost/api/ytm-lyrics";
    const POLL_MS = 1500;
    const GLOBAL_KEY = "__ytmLyricsRelayInstalled";

    if (window[GLOBAL_KEY]) return;
    window[GLOBAL_KEY] = true;

    const NativeMediaMetadata = window.MediaMetadata;
    if (!NativeMediaMetadata || !navigator.mediaSession) return;

    let lastSentKey = "";
    let inFlightKey = "";
    let lastObservedMetadata = null;

    function getTrackKey(metadata) {
        if (!metadata?.title) return "";
        return `${metadata.title}::${metadata.artist ?? ""}`;
    }

    function cloneValue(value) {
        if (typeof structuredClone === "function") {
            return structuredClone(value);
        }

        return JSON.parse(JSON.stringify(value));
    }

    function getLyricsBrowseId(player) {
        const tabs =
            player?.tabs ??
            player?.watchNextResponse?.contents?.singleColumnMusicWatchNextResultsRenderer
                ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ??
            [];

        const lyricsTab = tabs.find(
            (tab) =>
                tab?.tabRenderer?.endpoint?.browseEndpoint
                    ?.browseEndpointContextSupportedConfigs
                    ?.browseEndpointContextMusicConfig?.pageType ===
                "MUSIC_PAGE_TYPE_TRACK_LYRICS",
        );

        return lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId ?? null;
    }

    function getTrackState(metadata) {
        const trackKey = getTrackKey(metadata);
        const player = document.querySelector("ytmusic-player-page");
        const browseId = getLyricsBrowseId(player);

        if (!trackKey || !browseId) {
            return null;
        }

        return {
            title: metadata.title,
            artist: metadata.artist ?? "",
            album: metadata.album ?? "",
            browseId,
            dedupeKey: `${trackKey}::${browseId}`,
        };
    }

    function getRequestHeaders() {
        const headers = {
            "content-type": "application/json",
            "x-origin": location.origin,
            "x-youtube-bootstrap-logged-in": String(
                Number(!!globalThis.ytcfg?.get?.("LOGGED_IN")),
            ),
        };

        const authUser = globalThis.ytcfg?.get?.("SESSION_INDEX");
        const visitorData = globalThis.ytcfg?.get?.("VISITOR_DATA");
        const clientName = globalThis.ytcfg?.get?.("INNERTUBE_CONTEXT_CLIENT_NAME");
        const clientVersion = globalThis.ytcfg?.get?.("INNERTUBE_CLIENT_VERSION");

        if (authUser != null) {
            headers["x-goog-authuser"] = String(authUser);
        }
        if (visitorData) {
            headers["x-goog-visitor-id"] = String(visitorData);
        }
        if (clientName != null) {
            headers["x-youtube-client-name"] = String(clientName);
        }
        if (clientVersion) {
            headers["x-youtube-client-version"] = String(clientVersion);
        }

        return headers;
    }

    function getMobileBrowseContext() {
        const context = globalThis.ytcfg?.get?.("INNERTUBE_CONTEXT");
        if (!context) {
            throw new Error("Missing INNERTUBE_CONTEXT");
        }

        const cloned = cloneValue(context);
        cloned.client.clientName = "ANDROID_MUSIC";
        cloned.client.clientVersion = "7.21.50";
        return cloned;
    }

    async function fetchTimedLyrics(browseId) {
        const apiKey = globalThis.ytcfg?.get?.("INNERTUBE_API_KEY");
        if (!apiKey) {
            throw new Error("Missing INNERTUBE_API_KEY");
        }

        const response = await fetch(
            "/youtubei/v1/browse?prettyPrint=false&key=" +
                encodeURIComponent(apiKey),
            {
                method: "POST",
                credentials: "same-origin",
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    context: getMobileBrowseContext(),
                    browseId,
                }),
            },
        );

        if (!response.ok) {
            throw new Error(`Lyrics fetch failed with ${response.status}`);
        }

        const data = await response.json();
        return (
            data?.contents?.elementRenderer?.newElement?.type?.componentType
                ?.model?.timedLyricsModel?.lyricsData?.timedLyricsData ?? null
        );
    }

    function formatLrcTimestamp(milliseconds) {
        const totalMs = Math.max(0, Number(milliseconds) || 0);
        const minutes = Math.floor(totalMs / 60_000);
        const seconds = Math.floor(totalMs / 1_000) % 60;
        const centiseconds = Math.floor((totalMs % 1_000) / 10);

        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
    }

    function sanitizeLrcTag(value) {
        return String(value).replace(/[\[\]\r\n]/g, " ").trim();
    }

    function toLrc(trackState, timedLyricsData) {
        const lines = [];

        if (trackState.title) {
            lines.push(`[ti:${sanitizeLrcTag(trackState.title)}]`);
        }
        if (trackState.artist) {
            lines.push(`[ar:${sanitizeLrcTag(trackState.artist)}]`);
        }
        if (trackState.album) {
            lines.push(`[al:${sanitizeLrcTag(trackState.album)}]`);
        }

        for (const line of timedLyricsData) {
            const startMs = line?.cueRange?.startTimeMilliseconds;
            if (startMs == null) continue;

            const timestamp = formatLrcTimestamp(startMs);
            const text = typeof line?.lyricLine === "string" ? line.lyricLine : "";
            const segments = text.replace(/\r/g, "").split("\n");

            for (const segment of segments) {
                lines.push(`[${timestamp}]${segment}`);
            }
        }

        return lines.join("\n");
    }

    async function relay(metadata) {
        const trackState = getTrackState(metadata);
        if (!trackState) return;
        if (
            trackState.dedupeKey === lastSentKey ||
            trackState.dedupeKey === inFlightKey
        ) {
            return;
        }

        inFlightKey = trackState.dedupeKey;

        try {
            const timedLyricsData = await fetchTimedLyrics(trackState.browseId);
            const latestMetadata =
                navigator.mediaSession.metadata ?? lastObservedMetadata ?? metadata;
            const latestTrackState = getTrackState(latestMetadata);

            if (
                !latestTrackState ||
                latestTrackState.dedupeKey !== trackState.dedupeKey
            ) {
                return;
            }

            lastSentKey = trackState.dedupeKey;

            if (!Array.isArray(timedLyricsData) || timedLyricsData.length === 0) {
                return;
            }

            const response = await fetch(ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    lrc: toLrc(latestTrackState, timedLyricsData),
                }),
            });

            if (!response.ok) {
                throw new Error(`Relay failed with ${response.status}`);
            }
        } catch (error) {
            console.error("YTM lyrics relay failed", error);
            if (lastSentKey === trackState.dedupeKey) {
                lastSentKey = "";
            }
        } finally {
            if (inFlightKey === trackState.dedupeKey) {
                inFlightKey = "";
            }
        }
    }

    function observeMetadata(metadataInit) {
        lastObservedMetadata = metadataInit;
        if (navigator.mediaSession.playbackState === "playing") {
            void relay(metadataInit);
        }
    }

    class PatchedMediaMetadata extends NativeMediaMetadata {
        constructor(init = {}) {
            super(init);
            observeMetadata(init);
        }
    }

    Object.defineProperty(PatchedMediaMetadata, "name", {
        value: "MediaMetadata",
    });
    window.MediaMetadata = PatchedMediaMetadata;

    setInterval(() => {
        const metadata = navigator.mediaSession.metadata ?? lastObservedMetadata;
        if (!metadata) return;
        void relay(metadata);
    }, POLL_MS);
})();
