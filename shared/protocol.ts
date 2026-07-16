import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const LyricsTranslationLineSchema = Type.Object({
    startTimeMs: Type.Number({ minimum: 0 }),
    text: Type.String(),
});

export const LyricsPayloadSchema = Type.Object({
    lrc: Type.String(),
    translations: Type.Array(LyricsTranslationLineSchema),
    translationLanguage: Type.Union([Type.String(), Type.Null()]),
});

// videoId is the single identity key that joins a song to its lyrics.
export const SongUpdateSchema = Type.Object({
    videoId: Type.String({ minLength: 1 }),
    title: Type.String(),
    artist: Type.String(),
    album: Type.String(),
    artworkUrl: Type.Union([Type.String(), Type.Null()]),
    durationMicros: Type.Number({ minimum: 0 }),
});

export const LyricsUpdateSchema = Type.Object({
    videoId: Type.String({ minLength: 1 }),
    lyrics: LyricsPayloadSchema,
});

export const PlaybackUpdateSchema = Type.Object({
    timestampEpochMicros: Type.Number({ minimum: 0 }),
    elapsedTimeMicros: Type.Number({ minimum: 0 }),
    paused: Type.Boolean(),
});

export const CommandSymbolSchema = Type.Union([
    Type.Literal("<"),
    Type.Literal("_"),
    Type.Literal(">"),
    Type.Literal(">>"),
    Type.Literal("<<"),
    Type.Literal("|<<"),
    Type.Literal("|>>"),
]);

export const ClientRoleSchema = Type.Union([
    Type.Literal("player"),
    Type.Literal("visualizer"),
]);

export const SongUpdateMessageSchema = Type.Object({
    type: Type.Literal("SONG_UPDATE"),
    payload: SongUpdateSchema,
});
export const LyricsUpdateMessageSchema = Type.Object({
    type: Type.Literal("LYRICS_UPDATE"),
    payload: LyricsUpdateSchema,
});
export const PlaybackUpdateMessageSchema = Type.Object({
    type: Type.Literal("PLAYBACK_UPDATE"),
    payload: PlaybackUpdateSchema,
});
export const HelloMessageSchema = Type.Object({
    type: Type.Literal("HELLO"),
    role: ClientRoleSchema,
    clientId: Type.String({ minLength: 1 }),
});
export const CommandMessageSchema = Type.Object({
    type: Type.Literal("COMMAND"),
    command: CommandSymbolSchema,
});
export const SeekMessageSchema = Type.Object({
    type: Type.Literal("SEEK"),
    position: Type.Number({ minimum: 0 }),
});
export const ErrorMessageSchema = Type.Object({
    type: Type.Literal("ERROR"),
    message: Type.String(),
});
export const ClearMessageSchema = Type.Object({
    type: Type.Literal("CLEAR"),
});


// Events flow player -> host -> visualizer. The host forwards them verbatim, so
// they are valid in both directions.
export const EventMessageSchema = Type.Union([
    SongUpdateMessageSchema,
    LyricsUpdateMessageSchema,
    PlaybackUpdateMessageSchema,
    ClearMessageSchema
]);

export const ClientMessageSchema = Type.Union([
    HelloMessageSchema,
    SongUpdateMessageSchema,
    LyricsUpdateMessageSchema,
    PlaybackUpdateMessageSchema,
    CommandMessageSchema,
    SeekMessageSchema,
]);

export const ServerMessageSchema = Type.Union([
    SongUpdateMessageSchema,
    LyricsUpdateMessageSchema,
    PlaybackUpdateMessageSchema,
    CommandMessageSchema,
    SeekMessageSchema,
    ErrorMessageSchema,
    ClearMessageSchema
]);

export type LyricsTranslationLine = Static<typeof LyricsTranslationLineSchema>;
export type LyricsPayload = Static<typeof LyricsPayloadSchema>;
export type SongUpdate = Static<typeof SongUpdateSchema>;
export type LyricsUpdate = Static<typeof LyricsUpdateSchema>;
export type PlaybackUpdate = Static<typeof PlaybackUpdateSchema>;
export type CommandSymbol = Static<typeof CommandSymbolSchema>;
export type ClientRole = Static<typeof ClientRoleSchema>;
export type EventMessage = Static<typeof EventMessageSchema>;
export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;