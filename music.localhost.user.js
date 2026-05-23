// ==UserScript==
// @name         music.localhost
// @namespace    aadishv.dev
// @version      0.1.0
// @description  Relay high-resolution YouTube Music artwork to music.localhost without disturbing native Media Session behavior. **Vibeslop.**
// @match        https://music.youtube.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
    "use strict";

    const ENDPOINT = "https://music.localhost/api/ytm-artwork";
    const POLL_MS = 1000;
    const GLOBAL_KEY = "__ytmArtworkRelayInstalled";
    if (window[GLOBAL_KEY]) return;
    window[GLOBAL_KEY] = true;

    const NativeMediaMetadata = window.MediaMetadata;
    if (!NativeMediaMetadata || !navigator.mediaSession) return;

    let lastSentKey = "";
    let lastObservedMetadata = null;

    function getTrackKey(metadata) {
        if (!metadata?.title) return "";
        return `${metadata.title}::${metadata.artist ?? ""}`;
    }

    function upgradeArtworkUrl(url) {
        if (!url) return null;

        if (
            /yt3\.(googleusercontent|ggpht)\.com|lh3\.googleusercontent\.com/.test(
                url,
            )
        ) {
            return url
                .replace(/=w\d+-h\d+(-[^=]*)?$/i, "=s2000")
                .replace(/=s\d+(-[^=]*)?$/i, "=s2000")
                .replace(/=w\d+(-[^=]*)?$/i, "=s2000");
        }

        const videoId =
            url.match(
                /(?:i\.ytimg\.com|i\d?\.ytimg\.com)\/(?:vi|vi_webp)\/([^/?#]+)/,
            )?.[1] || new URL(location.href).searchParams.get("v");
        if (videoId) {
            return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
        }

        return url;
    }

    function getArtworkUrl(metadata) {
        const artwork = metadata?.artwork;
        if (!Array.isArray(artwork) || artwork.length === 0) return null;
        return upgradeArtworkUrl(artwork[0]?.src ?? null);
    }

    async function relay(metadata) {
        const trackKey = getTrackKey(metadata);
        const artworkUrl = getArtworkUrl(metadata);
        if (!trackKey || !artworkUrl) return;

        const dedupeKey = `${trackKey}::${artworkUrl}`;
        if (dedupeKey === lastSentKey) return;

        lastSentKey = dedupeKey;

        try {
            const response = await fetch(ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    title: metadata.title,
                    artist: metadata.artist ?? "",
                    album: metadata.album ?? "",
                    artworkUrl,
                    artworkType: metadata.artwork?.[0]?.type ?? "image/jpeg",
                }),
            });
            if (!response.ok) {
                throw new Error(`Relay failed with ${response.status}`);
            }
        } catch (error) {
            console.error("YTM artwork relay failed", error);
            lastSentKey = "";
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
        const metadata =
            navigator.mediaSession.metadata ?? lastObservedMetadata;
        if (!metadata || navigator.mediaSession.playbackState !== "playing")
            return;
        void relay(metadata);
    }, POLL_MS);
})();
