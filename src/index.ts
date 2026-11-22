// Vercel entry point: exposes the REST part of the server (health, room lookup/creation) as an Express app.
// IMPORTANT: Vercel runs short-lived serverless functions, so Socket.IO, the game timers and the in-memory rooms
// do NOT work here. The real-time game server is src/server.ts and must run on a host with a persistent process
// (Railway, Render, Fly.io, a VPS).
import "dotenv/config";
import express from "express";
import { loadEnv } from "./config/env.js";
import { createApp } from "./http/app.js";
import { GameManager } from "./game/gameManager.js";
import { RoomManager } from "./rooms/roomManager.js";
import { InMemoryRoomRepository, type RoomRepository } from "./services/roomRepository.js";
import { createSupabase } from "./services/supabase.js";
import { SupabaseRoomRepository } from "./services/supabaseRoomRepository.js";

const env = loadEnv();
const repo: RoomRepository = env.inMemory ? new InMemoryRoomRepository() : new SupabaseRoomRepository(createSupabase(env));
const manager = new RoomManager({ repo, timings: env.timings });
const game = new GameManager({ manager, timings: env.timings, testMode: false });

const app = express();
app.use(createApp({ manager, frontOrigin: env.frontOrigin, trustProxy: true, game }));

export default app;
