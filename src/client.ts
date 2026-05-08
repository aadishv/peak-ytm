import { Texture } from "pixi.js";
import { LyricsScene } from "./LyricsScene";

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

type PlaybackOverride = {
  elapsedMicros: number;
  startedAtMs: number;
  playing: boolean;
  playbackRate: number;
  trackKey: string;
};

const titleEl = document.querySelector<HTMLHeadingElement>("#title");
const metaEl = document.querySelector<HTMLParagraphElement>("#meta");
const artworkEl = document.querySelector<HTMLImageElement>("#artwork");
const fillEl = document.querySelector<HTMLDivElement>("#progress-fill");
const elapsedEl = document.querySelector<HTMLSpanElement>("#elapsed");
const remainingEl = document.querySelector<HTMLSpanElement>("#remaining");
const progressEl = document.querySelector<HTMLDivElement>("#progress");
const statusEl = document.querySelector<HTMLDivElement>("#status");
const seekEl = document.querySelector<HTMLInputElement>("#seek");
const previousEl = document.querySelector<HTMLButtonElement>("#previous");
const playPauseEl = document.querySelector<HTMLButtonElement>("#play-pause");
const nextEl = document.querySelector<HTMLButtonElement>("#next");
const playPauseSymbolEl = document.querySelector<HTMLSpanElement>("#play-pause-symbol");
const canvas = document.querySelector<HTMLCanvasElement>("#bg-canvas");

if (!titleEl || !metaEl || !artworkEl || !fillEl || !elapsedEl || !remainingEl || !progressEl || !statusEl || !seekEl || !previousEl || !playPauseEl || !nextEl || !playPauseSymbolEl || !canvas) {
  throw new Error("Missing required DOM nodes");
}

const SYMBOLS = {
  play: "􀊄",
  pause: "􀊆",
};

const scene = new LyricsScene(canvas, Texture.WHITE);
let lastArtworkKey: string | null = null;
let currentArtworkUrl: string | null = null;
let artworkRequestId = 0;
let lastArtworkTrackKey = "";
let isSeeking = false;
let pendingSeekMicros: number | null = null;
let playbackOverride: PlaybackOverride | null = null;
let state: MediaState | null = null;

const connect = () => {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener("open", () => {
    statusEl.textContent = "Connected";
  });

  ws.addEventListener("message", (event) => {
    const nextState = JSON.parse(String(event.data)) as MediaState | null;
    state = nextState;
    render(nextState);
  });

  ws.addEventListener("close", () => {
    statusEl.textContent = "Reconnecting…";
    window.setTimeout(connect, 1000);
  });

  ws.addEventListener("error", () => {
    statusEl.textContent = "Socket error";
    ws.close();
  });
};

const formatTime = (micros: number) => {
  const totalSeconds = Math.max(0, Math.floor(micros / 1_000_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const trackKey = (mediaState: MediaState | null) => {
  if (!mediaState?.title) return "";
  return String(mediaState.uniqueIdentifier ?? mediaState.contentItemIdentifier ?? `${mediaState.title}::${mediaState.artist ?? ""}::${mediaState.album ?? ""}`);
};

const currentElapsedMicros = () => {
  if (playbackOverride) {
    const deltaMicros = (Date.now() - playbackOverride.startedAtMs) * 1000;
    if (!playbackOverride.playing || playbackOverride.playbackRate <= 0) {
      return Math.max(0, playbackOverride.elapsedMicros);
    }
    return Math.max(0, playbackOverride.elapsedMicros + deltaMicros * playbackOverride.playbackRate);
  }

  if (!state) return 0;
  const base = state.elapsedTimeMicros ?? 0;
  const timestamp = state.timestampEpochMicros;
  const rate = state.playbackRate ?? (state.playing ? 1 : 0);
  if (!state.playing || !timestamp || rate <= 0) return base;
  const delta = Date.now() * 1000 - timestamp;
  return Math.max(0, base + delta * rate);
};

const render = (nextState: MediaState | null) => {
  if (playbackOverride) {
    const nextTrackKey = trackKey(nextState);
    const backendElapsed = nextState?.elapsedTimeMicros ?? 0;
    const overrideElapsed = currentElapsedMicros();
    if (!nextTrackKey || nextTrackKey !== playbackOverride.trackKey || Math.abs(backendElapsed - overrideElapsed) < 1_750_000) {
      playbackOverride = null;
    }
  }

  if (!nextState?.title) {
    titleEl.textContent = "Nothing playing";
    metaEl.textContent = "Waiting for MediaRemote…";
    progressEl.classList.add("hidden");
    statusEl.textContent = "Idle";
    playPauseSymbolEl.textContent = SYMBOLS.play;
    setControlsDisabled(true);
    void updateArtwork(null, null);
    return;
  }

  titleEl.textContent = nextState.title;
  const metaParts = [nextState.artist, nextState.album].filter((part): part is string => Boolean(part && part.trim()));
  metaEl.textContent = metaParts.length > 0 ? metaParts.join(" — ") : "Unknown album";
  progressEl.classList.toggle("hidden", !(nextState.durationMicros && nextState.durationMicros > 0));
  statusEl.textContent = nextState.playing ? "Playing" : "Paused";
  playPauseSymbolEl.textContent = nextState.playing ? SYMBOLS.pause : SYMBOLS.play;
  setControlsDisabled(false);
  void updateArtwork(nextState.artworkData ?? null, nextState.artworkMimeType ?? null);
};

const updateArtwork = async (artworkData: string | null, artworkMimeType: string | null) => {
  const requestId = ++artworkRequestId;
  const nextTrackKey = trackKey(state);
  const key = artworkData && artworkMimeType ? `${artworkMimeType}:${artworkData}` : null;
  if (key === lastArtworkKey) return;

  if (!artworkData || !artworkMimeType) {
    if (nextTrackKey && nextTrackKey === lastArtworkTrackKey && currentArtworkUrl) {
      return;
    }
    lastArtworkKey = null;
    lastArtworkTrackKey = "";
    if (currentArtworkUrl) {
      URL.revokeObjectURL(currentArtworkUrl);
      currentArtworkUrl = null;
    }
    artworkEl.src = "";
    scene.updateArtwork(Texture.WHITE);
    return;
  }

  lastArtworkKey = key;
  lastArtworkTrackKey = nextTrackKey;

  if (currentArtworkUrl) {
    URL.revokeObjectURL(currentArtworkUrl);
    currentArtworkUrl = null;
  }

  const binary = Uint8Array.from(atob(artworkData), (char) => char.charCodeAt(0));
  const blob = new Blob([binary], { type: artworkMimeType });
  const objectUrl = URL.createObjectURL(blob);
  currentArtworkUrl = objectUrl;
  artworkEl.src = objectUrl;

  const image = new Image();
  image.src = objectUrl;
  await image.decode().catch(() => undefined);

  if (requestId !== artworkRequestId) return;
  scene.updateArtwork(image);
};

const postJson = async (path: string, body: Record<string, unknown>) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? "Request failed");
  }
};

const setControlsDisabled = (disabled: boolean) => {
  playPauseEl.disabled = disabled;
  previousEl.disabled = disabled || Boolean(state?.prohibitsSkip);
  nextEl.disabled = disabled || Boolean(state?.prohibitsSkip);
  seekEl.disabled = disabled || !state?.durationMicros;
};

const commitSeek = async () => {
  if (pendingSeekMicros === null) return;
  const duration = state?.durationMicros ?? 0;
  const targetMicros = Math.max(0, Math.min(pendingSeekMicros, duration));
  pendingSeekMicros = null;

  playbackOverride = {
    elapsedMicros: targetMicros,
    startedAtMs: Date.now(),
    playing: Boolean(state?.playing),
    playbackRate: state?.playbackRate ?? (state?.playing ? 1 : 0),
    trackKey: trackKey(state),
  };

  try {
    setControlsDisabled(true);
    await postJson("/api/seek", { positionSeconds: targetMicros / 1_000_000 });
  } catch (error) {
    playbackOverride = null;
    statusEl.textContent = error instanceof Error ? error.message : "Seek failed";
  } finally {
    setControlsDisabled(false);
  }
};

const tick = () => {
  const duration = state?.durationMicros ?? 0;
  const elapsed = isSeeking && pendingSeekMicros !== null ? pendingSeekMicros : currentElapsedMicros();
  const ratio = duration > 0 ? Math.min(elapsed / duration, 1) : 0;
  fillEl.style.width = `${ratio * 100}%`;
  seekEl.value = String(ratio);
  elapsedEl.textContent = formatTime(elapsed);
  remainingEl.textContent = `-${formatTime(Math.max(duration - elapsed, 0))}`;
  requestAnimationFrame(tick);
};

const resize = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  scene.resize(window.innerWidth, window.innerHeight);
};

previousEl.addEventListener("click", async () => {
  try {
    setControlsDisabled(true);
    await postJson("/api/control", { command: "previous-track" });
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : "Control failed";
  } finally {
    setControlsDisabled(false);
  }
});

playPauseEl.addEventListener("click", async () => {
  try {
    setControlsDisabled(true);
    await postJson("/api/control", { command: "toggle-play-pause" });
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : "Control failed";
  } finally {
    setControlsDisabled(false);
  }
});

nextEl.addEventListener("click", async () => {
  try {
    setControlsDisabled(true);
    await postJson("/api/control", { command: "next-track" });
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : "Control failed";
  } finally {
    setControlsDisabled(false);
  }
});

seekEl.addEventListener("input", () => {
  isSeeking = true;
  const duration = state?.durationMicros ?? 0;
  pendingSeekMicros = duration * Number(seekEl.value);
});

seekEl.addEventListener("change", () => {
  void commitSeek().finally(() => {
    isSeeking = false;
  });
});

window.addEventListener("pointerup", () => {
  if (!isSeeking) return;
  void commitSeek().finally(() => {
    isSeeking = false;
  });
});

window.addEventListener("resize", resize);
resize();
setControlsDisabled(true);
connect();
tick();
