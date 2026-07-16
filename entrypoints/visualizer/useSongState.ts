import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import Liricle from "liricle";
import {
    ServerMessage,
    ServerMessageSchema,
    type ClientMessage,
    type CommandSymbol,
    type LyricsPayload,
    type LyricsTranslationLine,
    type LyricsUpdate,
    type PlaybackUpdate,
    type SongUpdate,
} from "../../shared/protocol";
import { Value } from "@sinclair/typebox/value";

type PlaybackOverride = {
    elapsedMicros: number;
    startedAtMs: number;
    paused: boolean;
    videoId: string;
};

declare global {
    interface Window {
        setLrcLyrics: (lyrics: string) => void;
        resetLrcLyrics: () => void;
    }
}

const LRC_OVERRIDE_EVENT = "lrc-lyrics-override-change";
let lrcLyricsOverride: string | null = null;

function setLrcLyricsOverride(lyrics: string | null): void {
    lrcLyricsOverride = lyrics;
    window.dispatchEvent(new Event(LRC_OVERRIDE_EVENT));
}

function useMediaState() {
    const [song, setSong] = useState<SongUpdate | null>(null);
    const [lyricsUpdate, setLyricsUpdate] = useState<LyricsUpdate | null>(null);
    const [playback, setPlayback] = useState<PlaybackUpdate | null>(null);
    const [isReady, setIsReady] = useState(false);
    const socketRef = useRef<WebSocket | null>(null);
    const clientIdRef = useRef(
        typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `visualizer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    useEffect(() => {
        const managerUrl = "ws://127.0.0.1:32145";
        const reconnectDelayMs = 2_000;
        let disposed = false;
        let reconnectTimer: number | null = null;

        const connect = () => {
            if (disposed) return;

            const socket = new WebSocket(managerUrl);
            socketRef.current = socket;

            socket.addEventListener("open", () => {
                if (disposed) {
                    socket.close();
                    return;
                }
                setIsReady(true);
                const hello: ClientMessage = {
                    type: "HELLO",
                    role: "visualizer",
                    clientId: clientIdRef.current,
                };
                socket.send(JSON.stringify(hello));
            });

            socket.addEventListener("message", (event) => {
                let message: ServerMessage;
                try {
                    message = Value.Parse(ServerMessageSchema, JSON.parse(String(event.data)));
                } catch {
                    return;
                }

                if (message.type === "SONG_UPDATE") {
                    setSong(message.payload);
                } else if (message.type === "LYRICS_UPDATE") {
                    setLyricsUpdate(message.payload);
                } else if (message.type === "PLAYBACK_UPDATE") {
                    setPlayback(message.payload);
                } else if (message.type === "CLEAR") {
                    setSong(null);
                    setLyricsUpdate(null);
                    setPlayback(null);
                } else if (message.type === "ERROR") {
                    console.warn(`Native manager: ${message.message}`);
                }
            });

            socket.addEventListener("close", () => {
                if (socketRef.current === socket) socketRef.current = null;
                if (disposed) return;

                setIsReady(false);
                setSong(null);
                setLyricsUpdate(null);
                setPlayback(null);
                reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
            });

            socket.addEventListener("error", () => socket.close());
        };

        connect();

        return () => {
            disposed = true;
            if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
            socketRef.current?.close();
            socketRef.current = null;
        };
    }, []);

    const sendMessage = useCallback((message: ClientMessage) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error("Native manager is disconnected");
        }
        socket.send(JSON.stringify(message));
    }, []);

    const sendCommand = useCallback(
        (command: CommandSymbol): void => {
            sendMessage({ type: "COMMAND", command });
        },
        [sendMessage],
    );

    const sendSeek = useCallback(
        (positionSeconds: number): void => {
            sendMessage({ type: "SEEK", position: positionSeconds });
        },
        [sendMessage],
    );

    return {
        isReady,
        song,
        lyricsUpdate,
        playback,
        sendCommand,
        sendSeek,
    };
}

type LiricleLine = {
    index?: number;
    time: number;
    text: string;
    words?: Array<{ index?: number; time: number; text: string }> | null;
};

type VisualizerLyricsLine = LiricleLine & {
    translatedText: string | null;
};

function normalizeLyricText(text: string): string {
    return text
        .normalize("NFKC")
        .replace(/[♪♫♬♩♭♯·•・,.;:!?()[\]{}"'`~\-_/\\|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
}

function shouldConsumeTranslation(text: string): boolean {
    const normalized = normalizeLyricText(text);

    if (!normalized) {
        return false;
    }

    return /[\p{L}\p{N}]/u.test(normalized);
}

function mapTranslationsToLines(
    lines: LiricleLine[],
    translations: LyricsTranslationLine[],
): VisualizerLyricsLine[] {
    let translationIndex = 0;

    return lines.map((line) => {
        const rawTranslatedText = shouldConsumeTranslation(line.text)
            ? translations[translationIndex++]?.text ?? null
            : null;
        const translatedText =
            rawTranslatedText &&
            normalizeLyricText(rawTranslatedText) !== normalizeLyricText(line.text)
                ? rawTranslatedText
                : null;

        return {
            ...line,
            translatedText,
        };
    });
}

function useLyrics(
    lyricsData: LyricsPayload | null,
    elapsedMicros: number,
) {
    const [overrideLyrics, setOverrideLyrics] = useState<string | null>(lrcLyricsOverride);

    useEffect(() => {
        const handleOverrideChange = () => {
            setOverrideLyrics(lrcLyricsOverride);
        };

        window.addEventListener(LRC_OVERRIDE_EVENT, handleOverrideChange);
        return () => {
            window.removeEventListener(LRC_OVERRIDE_EVENT, handleOverrideChange);
        };
    }, []);

    const activeLyrics = overrideLyrics ?? lyricsData?.lrc ?? null;

    const [liricleInstance, setLiricleInstance] = useState<Liricle | null>(null);
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    useEffect(() => {
        if (activeLyrics) {
            const newLiricle = new Liricle();
            newLiricle.offset = 300;
            newLiricle.load({ text: activeLyrics });
            newLiricle.on("sync", (e) => {
                setFocusedIndex(e?.index ?? -1);
                const focusedLine = document.getElementById(`line-${e?.index}`);
                if (focusedLine) {
                    focusedLine.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                        inline: "center",
                    });
                }
            });
            setLiricleInstance(newLiricle);
            setFocusedIndex(-1);
        } else {
            setLiricleInstance(null);
            setFocusedIndex(null);
        }
    }, [activeLyrics]);

    useEffect(() => {
        if (liricleInstance) {
            liricleInstance.sync(elapsedMicros / 1_000_000);
        }
    }, [elapsedMicros, liricleInstance]);

    const lines = useMemo(
        () =>
            mapTranslationsToLines(
                liricleInstance?.data?.lines ?? [],
                lyricsData?.translations ?? [],
            ),
        [liricleInstance?.data?.lines, lyricsData?.translations],
    );

    return {
        lyrics: lines,
        focusedIndex,
        translationLanguage: lyricsData?.translationLanguage ?? null,
    };
}

function getBackendElapsedMicros(playback: PlaybackUpdate | null): number {
    if (!playback) {
        return 0;
    }

    const base = playback.elapsedTimeMicros ?? 0;
    const timestamp = playback.timestampEpochMicros;

    if (playback.paused || !timestamp) {
        return base;
    }

    return Math.max(0, base + (Date.now() * 1000 - timestamp));
}

function getOverrideElapsedMicros(override: PlaybackOverride | null): number {
    if (!override) {
        return 0;
    }

    if (override.paused) {
        return Math.max(0, override.elapsedMicros);
    }

    return Math.max(
        0,
        override.elapsedMicros + (Date.now() - override.startedAtMs) * 1000,
    );
}

function usePlaybackClock(
    playback: PlaybackUpdate | null,
    durationMicros: number,
    videoId: string | null,
    sendSeek: (positionSeconds: number) => void,
    setStatus: Dispatch<SetStateAction<string>>,
) {
    const [playbackOverride, setPlaybackOverride] =
        useState<PlaybackOverride | null>(null);
    const [isSeeking, setIsSeeking] = useState(false);
    const [pendingSeekMicros, setPendingSeekMicros] = useState<number | null>(
        null,
    );
    const [, setFrame] = useState(0);

    useEffect(() => {
        let frameId = 0;

        const tick = () => {
            setFrame((frame) => frame + 1);
            frameId = requestAnimationFrame(tick);
        };

        frameId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frameId);
    }, []);

    useEffect(() => {
        if (!playbackOverride) {
            return;
        }

        const backendElapsed = playback?.elapsedTimeMicros ?? 0;
        const overrideElapsed = getOverrideElapsedMicros(playbackOverride);

        if (
            !videoId ||
            videoId !== playbackOverride.videoId ||
            Math.abs(backendElapsed - overrideElapsed) < 1_750_000
        ) {
            setPlaybackOverride(null);
        }
    }, [playback, videoId, playbackOverride]);

    const elapsedMicros =
        isSeeking && pendingSeekMicros !== null
            ? pendingSeekMicros
            : playbackOverride
              ? getOverrideElapsedMicros(playbackOverride)
              : getBackendElapsedMicros(playback);
    const progressRatio =
        durationMicros > 0 ? Math.min(elapsedMicros / durationMicros, 1) : 0;

    const handleSeekInput = useCallback(
        (value: string): void => {
            setIsSeeking(true);
            setPendingSeekMicros(durationMicros * Number(value));
        },
        [durationMicros],
    );

    const handleSeekCommit = useCallback(async (): Promise<void> => {
        setIsSeeking(false);

        if (pendingSeekMicros === null) {
            return;
        }

        const targetMicros = Math.max(
            0,
            Math.min(pendingSeekMicros, durationMicros),
        );
        setPendingSeekMicros(null);
        setPlaybackOverride({
            elapsedMicros: targetMicros,
            startedAtMs: Date.now(),
            paused: playback?.paused ?? true,
            videoId: videoId ?? "",
        });

        try {
            sendSeek(targetMicros / 1_000_000);
        } catch (error) {
            setPlaybackOverride(null);
            setStatus(error instanceof Error ? error.message : "Seek failed");
        }
    }, [
        videoId,
        durationMicros,
        pendingSeekMicros,
        playback?.paused,
        sendSeek,
        setStatus,
    ]);

    return {
        elapsedMicros,
        handleSeekCommit,
        handleSeekInput,
        progressRatio,
    };
}

if (typeof window !== "undefined") {
    window.setLrcLyrics = (lyrics: string) => {
        setLrcLyricsOverride(lyrics);
    };
    window.resetLrcLyrics = () => {
        setLrcLyricsOverride(null);
    };
}

export function useSongState() {
    const { isReady, song, lyricsUpdate, playback, sendCommand, sendSeek } =
        useMediaState();
    const [status, setStatus] = useState("Connecting…");

    const imageUrl = song?.artworkUrl ?? null;
    const durationMicros = song?.durationMicros ?? 0;
    const playing = playback ? !playback.paused : false;
    const hasSong = song !== null;

    // Lyrics only apply to the current track: unless the latest lyrics update
    // matches the current song's videoId, they are treated as absent so stale
    // lyrics from the previous track are never shown.
    const activeLyrics =
        song && lyricsUpdate && lyricsUpdate.videoId === song.videoId
            ? lyricsUpdate.lyrics
            : null;

    const {
        elapsedMicros,
        handleSeekCommit,
        handleSeekInput,
        progressRatio,
    } = usePlaybackClock(
        playback,
        durationMicros,
        song?.videoId ?? null,
        sendSeek,
        setStatus,
    );
    const controlsBusy = !isReady;

    const lyrics = useLyrics(activeLyrics, elapsedMicros);

    useEffect(() => {
        if (!song?.title) {
            setStatus(isReady ? "Idle" : "Connecting…");
            return;
        }

        setStatus(playing ? "Playing" : "Paused");
    }, [isReady, song, playing]);

    const handleCommand = useCallback(
        async (command: CommandSymbol): Promise<void> => {
            try {
                sendCommand(command);
            } catch (error) {
                setStatus(
                    error instanceof Error ? error.message : "Control failed",
                );
            }
        },
        [sendCommand],
    );

    return {
        controlsBusy,
        durationMicros,
        elapsedMicros,
        handleCommand,
        handleSeekCommit,
        handleSeekInput,
        imageUrl,
        hasSong,
        playing,
        progressRatio,
        status,
        title: song?.title ?? "",
        artist: song?.artist ?? null,
        album: song?.album ?? null,
        lyrics,
    };
}
