import { useEffect, useMemo, useState } from "react";

type MediaState = {
  title?: string;
  artist?: string | null;
  album?: string | null;
  playing?: boolean;
  artworkData?: string | null;
  artworkMimeType?: string | null;
  elapsedTimeMicros?: number | null;
  durationMicros?: number | null;
  timestampEpochMicros?: number | null;
  playbackRate?: number | null;
  prohibitsSkip?: boolean | null;
  uniqueIdentifier?: string | null;
  contentItemIdentifier?: string | null;
};

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

const CONTROL_COMMANDS = ["previous-track", "toggle-play-pause", "next-track"] as const;

type ControlCommand = (typeof CONTROL_COMMANDS)[number];

function formatMeta(mediaState: MediaState | null): string {
  if (!mediaState?.title) {
    return "Waiting for MediaRemote…";
  }

  return [mediaState.artist, mediaState.album]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" — ") || "Unknown album";
}

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

async function postJson(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? "Request failed");
  }
}

function decodeArtwork(artworkState: ArtworkState): string {
  const binary = Uint8Array.from(atob(artworkState.data), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([binary], { type: artworkState.mimeType }));
}

export function useSongState() {
  const [mediaState, setMediaState] = useState<MediaState | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [controlsBusy, setControlsBusy] = useState(true);
  const [artworkState, setArtworkState] = useState<ArtworkState | null>(null);
  const [playbackOverride, setPlaybackOverride] = useState<PlaybackOverride | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [pendingSeekMicros, setPendingSeekMicros] = useState<number | null>(null);
  const [, setFrame] = useState(0);

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
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      socket = new WebSocket(`${protocol}//${location.host}/ws`);

      socket.addEventListener("open", () => {
        setStatus("Connected");
      });

      socket.addEventListener("message", (event) => {
        setMediaState(JSON.parse(String(event.data)) as MediaState | null);
      });

      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }

        setStatus("Reconnecting…");
        reconnectTimer = window.setTimeout(connect, 1000);
      });

      socket.addEventListener("error", () => {
        setStatus("Socket error");
        socket?.close();
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
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
      setControlsBusy(true);
      setStatus("Idle");
      return;
    }

    setControlsBusy(false);
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
  }, [mediaState, trackKey]);

  const imageUrl = useMemo(() => artworkState ? decodeArtwork(artworkState) : null, [artworkState]);

  useEffect(() => {
    if (!imageUrl) {
      return;
    }

    return () => {
      URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const durationMicros = mediaState?.durationMicros ?? 0;
  const elapsedMicros = isSeeking && pendingSeekMicros !== null
    ? pendingSeekMicros
    : playbackOverride
      ? getOverrideElapsedMicros(playbackOverride)
      : getBackendElapsedMicros(mediaState);
  const progressRatio = durationMicros > 0 ? Math.min(elapsedMicros / durationMicros, 1) : 0;

  const handleControl = async (command: ControlCommand): Promise<void> => {
    try {
      setControlsBusy(true);
      await postJson("/api/control", { command });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Control failed");
    } finally {
      setControlsBusy(false);
    }
  };

  const handleSeekInput = (value: string): void => {
    setIsSeeking(true);
    setPendingSeekMicros(durationMicros * Number(value));
  };

  const handleSeekCommit = async (): Promise<void> => {
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
      setControlsBusy(true);
      await postJson("/api/seek", { positionSeconds: targetMicros / 1_000_000 });
    } catch (error) {
      setPlaybackOverride(null);
      setStatus(error instanceof Error ? error.message : "Seek failed");
    } finally {
      setControlsBusy(false);
    }
  };

  return {
    artworkState,
    controlsBusy,
    durationMicros,
    elapsedMicros,
    handleControl,
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
