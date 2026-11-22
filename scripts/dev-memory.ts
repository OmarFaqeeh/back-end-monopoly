// Local development server WITHOUT Supabase: same app, rooms kept only in memory (lost on restart).
// Usage: npm run dev:memory   (PORT and FRONT_ORIGIN are optional here; ROOM_EMPTY_TIMEOUT_MS shortens the timer).
import http from "node:http";
import { Server } from "socket.io";
import { DEFAULT_TIMINGS } from "../src/config/defaults.js";
import { createApp } from "../src/http/app.js";
import { RoomManager } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";
import { registerRoomHandlers } from "../src/sockets/roomHandlers.js";

const port = Number(process.env.PORT ?? 4000);
const frontOrigin = (process.env.FRONT_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
const emptyTimeoutMs = Number(process.env.ROOM_EMPTY_TIMEOUT_MS ?? DEFAULT_TIMINGS.emptyTimeoutMs);

const manager = new RoomManager({ repo: new InMemoryRoomRepository(), timings: { ...DEFAULT_TIMINGS, emptyTimeoutMs } });
const server = http.createServer(createApp({ manager, frontOrigin }));
registerRoomHandlers(new Server(server, { cors: { origin: frontOrigin } }), manager);
setInterval(() => void manager.sweep(), 30_000).unref();
server.listen(port, () => console.log(`In-memory Deal Rush server on :${port} (no database; empty timer ${emptyTimeoutMs} ms)`));
