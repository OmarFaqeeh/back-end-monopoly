// Entry point: Express + Socket.IO + Supabase. Single instance only (rooms and timers live in memory).
import "dotenv/config";
import http from "node:http";
import { Server } from "socket.io";
import { EnvError, loadEnv } from "./config/env.js";
import { JANITOR_INTERVAL_MS } from "./config/defaults.js";
import { createApp } from "./http/app.js";
import { GameManager } from "./game/gameManager.js";
import { BotManager } from "./rooms/botManager.js";
import { RoomManager } from "./rooms/roomManager.js";
import { InMemoryRoomRepository, type RoomRepository } from "./services/roomRepository.js";
import { createSupabase } from "./services/supabase.js";
import { SupabaseRoomRepository } from "./services/supabaseRoomRepository.js";
import { registerRoomHandlers } from "./sockets/roomHandlers.js";

async function main() {
  const env = loadEnv();
  const repo: RoomRepository = env.inMemory ? new InMemoryRoomRepository() : new SupabaseRoomRepository(createSupabase(env));
  if (env.inMemory) console.log("USE_IN_MEMORY_REPO=1: rooms are kept in memory only (no database).");

  // In-memory state is gone after a restart, so every room still open in the database is closed first.
  const closed = await repo.closeAllActive("SERVER_RESTART");
  if (closed > 0) console.log(`Closed ${closed} stale room(s) from the previous run.`);

  const manager = new RoomManager({ repo, timings: env.timings });
  const game = new GameManager({ manager, timings: env.timings, testMode: process.env.NODE_ENV === "test" });
  const app = createApp({ manager, frontOrigin: env.frontOrigins, trustProxy: env.trustProxy, game });
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: env.frontOrigins } });
  const bots = new BotManager(manager);
  registerRoomHandlers(io, manager, game, bots);

  const janitor = setInterval(() => void manager.sweep().catch((e) => console.error("[janitor]", e)), JANITOR_INTERVAL_MS);
  janitor.unref();

  server.listen(env.port, () => {
    console.log(`Deal Rush server listening on :${env.port} (front origin: ${env.frontOrigin})`);
  });

  const shutdown = () => {
    clearInterval(janitor);
    bots.dispose();
    game.dispose();
    manager.dispose();
    void repo.closeAllActive("SERVER_RESTART").finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof EnvError ? e.message : `Failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
