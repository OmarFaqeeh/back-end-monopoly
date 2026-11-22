// Vercel entry point: exposes the REST part of the server (health, room lookup/creation) as an Express app.
// IMPORTANT: Vercel runs short-lived serverless functions, so Socket.IO, the game timers and the in-memory rooms
// do NOT work here. The real-time game server is src/server.ts and must run on a host with a persistent process
// (Railway, Render, Fly.io, a VPS).
import "dotenv/config";
import cors from "cors";
import express from "express";
import { DEPLOYED_ORIGINS, EnvError, loadEnv } from "./config/env.js";
import { createApp } from "./http/app.js";
import { GameManager } from "./game/gameManager.js";
import { RoomManager } from "./rooms/roomManager.js";
import { InMemoryRoomRepository, type RoomRepository } from "./services/roomRepository.js";
import { createSupabase } from "./services/supabase.js";
import { SupabaseRoomRepository } from "./services/supabaseRoomRepository.js";

function build(): express.Express {
  const app = express();
  try {
    const env = loadEnv();
    const repo: RoomRepository = env.inMemory ? new InMemoryRoomRepository() : new SupabaseRoomRepository(createSupabase(env));
    const manager = new RoomManager({ repo, timings: env.timings });
    const game = new GameManager({ manager, timings: env.timings, testMode: false });
    app.use(createApp({ manager, frontOrigin: env.frontOrigins, trustProxy: true, game }));
  } catch (e) {
    // A missing setting must show up as a readable answer (with CORS headers), not as a crashed function.
    const detail = e instanceof EnvError ? e.message : "startup failed";
    console.error(e instanceof Error ? e.message : e);
    app.use(cors({ origin: DEPLOYED_ORIGINS }));
    app.use((_req, res) => void res.status(500).json({ error: "SERVER_MISCONFIGURED", detail }));
  }
  return app;
}

export default build();
