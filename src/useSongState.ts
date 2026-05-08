import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandMessage, CommandSymbol, MediaState } from "./schemas";

type ArtworkState = {
  data: string;
  mimeType: string;
  trackKey: string;
};

type PlaybackOverride = {
  elapsedMicros: number;
  startedAtMs: number;
  playing: boolean;
  playbackRate: number;
  trackKey: string;
};

type SocketCommandMessage = CommandMessage;

function getTrackKey(mediaState: MediaState | null): string {
  if (!mediaState?.title) {
    return "";
  }

  return String(
    mediaState.uniqueIdentifier
      ?? mediaState.contentItemIdentifier
      ?? `${mediaState.title}::${mediaState.artist ?? ""}::${mediaState.album ?? ""}`,
  );
}

function getBackendElapsedMicros(mediaState: MediaState | null): number {
  if (!mediaState) {
    return 0;
  }

  const base = mediaState.elapsedTimeMicros ?? 0;
  const timestamp = mediaState.timestampEpochMicros;
  const playbackRate = mediaState.playbackRate ?? (mediaState.playing ? 1 : 0);

  if (!mediaState.playing || !timestamp || playbackRate <= 0) {
    return base;
  }

  return Math.max(0, base + (Date.now() * 1000 - timestamp) * playbackRate);
}

function getOverrideElapsedMicros(override: PlaybackOverride | null): number {
  if (!override) {
    return 0;
  }

  if (!override.playing || override.playbackRate <= 0) {
    return Math.max(0, override.elapsedMicros);
  }

  return Math.max(0, override.elapsedMicros + (Date.now() - override.startedAtMs) * 1000 * override.playbackRate);
}

function decodeArtwork(artworkState: ArtworkState): string {
  const binary = Uint8Array.from(atob(artworkState.data), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([binary], { type: artworkState.mimeType }));
}

function getSocketUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export function useSongState() {
  const [mediaState, setMediaState] = useState<MediaState | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [socketReady, setSocketReady] = useState(false);
  const [artworkState, setArtworkState] = useState<ArtworkState | null>(null);
  const [playbackOverride, setPlaybackOverride] = useState<PlaybackOverride | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [pendingSeekMicros, setPendingSeekMicros] = useState<number | null>(null);
  const [, setFrame] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const trackKey = useMemo(() => getTrackKey(mediaState), [mediaState]);

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
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      const socket = new WebSocket(getSocketUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed) {
          return;
        }

        setSocketReady(true);
        setStatus("Connected");
      });

      socket.addEventListener("message", (event) => {
        if (disposed) {
          return;
        }

        try {
          const nextState = JSON.parse(String(event.data)) as MediaState;
          setMediaState(nextState);
        } catch {
          setStatus("Invalid state");
        }
      });

      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }

        setSocketReady(false);
        setStatus("Reconnecting…");
        reconnectTimer = window.setTimeout(connect, 1000);
      });

      socket.addEventListener("error", () => {
        if (disposed) {
          return;
        }

        setStatus("Socket error");
        socket.close();
      });
    };

    connect();

    return () => {
      disposed = true;
      setSocketReady(false);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!playbackOverride) {
      return;
    }

    const backendElapsed = mediaState?.elapsedTimeMicros ?? 0;
    const overrideElapsed = getOverrideElapsedMicros(playbackOverride);

    if (!trackKey || trackKey !== playbackOverride.trackKey || Math.abs(backendElapsed - overrideElapsed) < 1_750_000) {
      setPlaybackOverride(null);
    }
  }, [mediaState, playbackOverride, trackKey]);

  useEffect(() => {
    if (!mediaState?.title) {
      setArtworkState(null);
      setStatus(socketReady ? "Idle" : "Connecting…");
      return;
    }

    setStatus(mediaState.playing ? "Playing" : "Paused");

    const { artworkData, artworkMimeType } = mediaState;

    if (!artworkData || !artworkMimeType) {
      setArtworkState((current) => current?.trackKey === trackKey ? current : null);
      return;
    }

    setArtworkState((current) => {
      if (
        current
        && current.trackKey === trackKey
        && current.mimeType === artworkMimeType
        && current.data === artworkData
      ) {
        return current;
      }

      return {
        data: artworkData,
        mimeType: artworkMimeType,
        trackKey,
      };
    });
  }, [mediaState, socketReady, trackKey]);

  const imageUrl = useMemo(() => artworkState ? decodeArtwork(artworkState) : null, [artworkState]);

  useEffect(() => {
    if (!imageUrl) {
      return;
    }

    return () => {
      URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const sendMessage = useCallback((message: SocketCommandMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Socket disconnected");
    }

    socket.send(JSON.stringify(message));
  }, []);

  const durationMicros = mediaState?.durationMicros ?? 0;
  const elapsedMicros = isSeeking && pendingSeekMicros !== null
    ? pendingSeekMicros
    : playbackOverride
      ? getOverrideElapsedMicros(playbackOverride)
      : getBackendElapsedMicros(mediaState);
  const progressRatio = durationMicros > 0 ? Math.min(elapsedMicros / durationMicros, 1) : 0;
  const controlsBusy = !socketReady;

  const handleCommand = useCallback(async (command: CommandSymbol): Promise<void> => {
    try {
      sendMessage({ type: "command", command });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Control failed");
    }
  }, [sendMessage]);

  const handleSeekInput = useCallback((value: string): void => {
    setIsSeeking(true);
    setPendingSeekMicros(durationMicros * Number(value));
  }, [durationMicros]);

  const handleSeekCommit = useCallback(async (): Promise<void> => {
    setIsSeeking(false);

    if (pendingSeekMicros === null) {
      return;
    }

    const targetMicros = Math.max(0, Math.min(pendingSeekMicros, durationMicros));
    setPendingSeekMicros(null);
    setPlaybackOverride({
      elapsedMicros: targetMicros,
      startedAtMs: Date.now(),
      playing: Boolean(mediaState?.playing),
      playbackRate: mediaState?.playbackRate ?? (mediaState?.playing ? 1 : 0),
      trackKey,
    });

    try {
      sendMessage({ type: "seek", position: targetMicros / 1_000_000 });
    } catch (error) {
      setPlaybackOverride(null);
      setStatus(error instanceof Error ? error.message : "Seek failed");
    }
  }, [durationMicros, mediaState?.playing, mediaState?.playbackRate, pendingSeekMicros, sendMessage, trackKey]);

  return {
    artworkState,
    controlsBusy,
    durationMicros,
    elapsedMicros,
    handleCommand,
    handleSeekCommit,
    handleSeekInput,
    imageUrl,
    mediaState,
    progressRatio,
    status,
    title: mediaState?.title ?? "Nothing playing",
    artist: mediaState?.artist ?? null,
    album: mediaState?.album ?? null,
  };
}

export type { ArtworkState, MediaState };
