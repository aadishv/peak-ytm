export type LyricsTranslationLine = {
    startTimeMs: number;
    text: string;
};

export type LyricsPayload = {
    lrc: string;
    translations: LyricsTranslationLine[];
    translationLanguage: string | null;
};

export type PlayerSnapshot = {
    title: string;
    artist: string;
    album: string;
    artworkUrl: string | null;
    lyrics: LyricsPayload | null;
    playing: boolean;
    durationMicros: number;
    elapsedTimeMicros: number;
    timestampEpochMicros: number;
    playbackRate: number;
};

export const COMMAND_SYMBOLS = ["<", "_", ">", ">>", "<<", "|<<", "|>>"] as const;
export type CommandSymbol = (typeof COMMAND_SYMBOLS)[number];
export type ClientRole = "player" | "visualizer";

export type ClientMessage =
    | { type: "HELLO"; role: ClientRole; clientId: string }
    | { type: "PLAYER_SNAPSHOT"; payload: PlayerSnapshot }
    | { type: "COMMAND"; command: CommandSymbol }
    | { type: "SEEK"; position: number };

export type ServerMessage =
    | { type: "STATE_UPDATE"; payload: PlayerSnapshot | null }
    | { type: "COMMAND"; command: CommandSymbol }
    | { type: "SEEK"; position: number }
    | { type: "ERROR"; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isCommandSymbol(value: unknown): value is CommandSymbol {
    return typeof value === "string" && (COMMAND_SYMBOLS as readonly string[]).includes(value);
}

export function isLyricsPayload(value: unknown): value is LyricsPayload {
    if (!isObject(value) || typeof value.lrc !== "string") return false;
    if (value.translationLanguage !== null && typeof value.translationLanguage !== "string") {
        return false;
    }
    if (!Array.isArray(value.translations)) return false;

    return value.translations.every(
        (line) =>
            isObject(line) &&
            isFiniteNonNegativeNumber(line.startTimeMs) &&
            typeof line.text === "string",
    );
}

export function isPlayerSnapshot(value: unknown): value is PlayerSnapshot {
    if (!isObject(value)) return false;

    return (
        typeof value.title === "string" &&
        typeof value.artist === "string" &&
        typeof value.album === "string" &&
        (value.artworkUrl === null || typeof value.artworkUrl === "string") &&
        (value.lyrics === null || isLyricsPayload(value.lyrics)) &&
        typeof value.playing === "boolean" &&
        isFiniteNonNegativeNumber(value.durationMicros) &&
        isFiniteNonNegativeNumber(value.elapsedTimeMicros) &&
        isFiniteNonNegativeNumber(value.timestampEpochMicros) &&
        isFiniteNonNegativeNumber(value.playbackRate)
    );
}

export function isClientMessage(value: unknown): value is ClientMessage {
    if (!isObject(value) || typeof value.type !== "string") return false;

    switch (value.type) {
        case "HELLO":
            return (
                (value.role === "player" || value.role === "visualizer") &&
                typeof value.clientId === "string" &&
                value.clientId.trim().length > 0
            );
        case "PLAYER_SNAPSHOT":
            return isPlayerSnapshot(value.payload);
        case "COMMAND":
            return isCommandSymbol(value.command);
        case "SEEK":
            return isFiniteNonNegativeNumber(value.position);
        default:
            return false;
    }
}

export function isServerMessage(value: unknown): value is ServerMessage {
    if (!isObject(value) || typeof value.type !== "string") return false;

    switch (value.type) {
        case "STATE_UPDATE":
            return value.payload === null || isPlayerSnapshot(value.payload);
        case "COMMAND":
            return isCommandSymbol(value.command);
        case "SEEK":
            return isFiniteNonNegativeNumber(value.position);
        case "ERROR":
            return typeof value.message === "string";
        default:
            return false;
    }
}
