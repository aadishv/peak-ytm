import { Value } from "@sinclair/typebox/value";
import {
    ClientMessageSchema,
    ServerMessage,
    ServerMessageSchema,
    type ClientMessage,
} from "../shared/protocol";

export default defineContentScript({
    matches: ["*://music.youtube.com/*"],
    runAt: "document_start",
    main() {
        const managerUrl = "ws://127.0.0.1:32145";
        const reconnectDelayMs = 2_000;
        const clientId =
            typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        let socket: WebSocket | null = null;
        let reconnectTimer: number | null = null;
        let lastSnapshot: PlayerSnapshot | null = null;
        let loggedUnavailable = false;

        function send(message: ClientMessage): void {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
            }
        }

        function scheduleReconnect(): void {
            if (reconnectTimer !== null) return;
            reconnectTimer = window.setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, reconnectDelayMs);
        }

        function connect(): void {
            if (
                socket &&
                (socket.readyState === WebSocket.OPEN ||
                    socket.readyState === WebSocket.CONNECTING)
            ) {
                return;
            }

            const nextSocket = new WebSocket(managerUrl);
            socket = nextSocket;

            nextSocket.addEventListener("open", () => {
                loggedUnavailable = false;
                send({ type: "HELLO", role: "player", clientId });
                if (lastSnapshot) {
                    send({ type: "PLAYER_SNAPSHOT", payload: lastSnapshot });
                }
            });

            nextSocket.addEventListener("message", (event) => {
                let message: ServerMessage;
                try {
                    message = Value.Parse(ServerMessageSchema, JSON.parse(String(event.data)));
                } catch {
                    return;
                }

                if (message.type === "COMMAND" || message.type === "SEEK") {
                    window.postMessage(
                        {
                            source: "ytm-isolated",
                            type: message.type,
                            payload: message,
                        },
                        "*",
                    );
                } else if (message.type === "ERROR") {
                    console.warn(`[YTM] Native manager: ${message.message}`);
                }
            });

            nextSocket.addEventListener("close", () => {
                if (socket === nextSocket) socket = null;
                if (!loggedUnavailable) {
                    console.warn(`[YTM] Native manager unavailable at ${managerUrl}`);
                    loggedUnavailable = true;
                }
                scheduleReconnect();
            });

            nextSocket.addEventListener("error", () => {
                nextSocket.close();
            });
        }

        window.addEventListener("message", (event) => {
            if (
                event.source !== window ||
                !event.data ||
                event.data.source !== "ytm-main"
            ) {
                return;
            }

            const snapshot = event.data.payload;
            lastSnapshot = snapshot;
            send({ type: "PLAYER_SNAPSHOT", payload: snapshot });
        });

        connect();
    },
});
