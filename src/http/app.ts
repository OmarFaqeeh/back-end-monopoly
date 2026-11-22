// Express app: security headers, CORS restricted to FRONT_ORIGIN, small JSON bodies, stable JSON errors.
import cors from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import type { GameManager } from "../game/gameManager.js";
import type { RoomManager } from "../rooms/roomManager.js";
import { roomsRouter } from "./routes/rooms.js";
import { testRouter } from "./routes/test.js";

export function createApp(opts: { manager: RoomManager; frontOrigin: string | string[]; trustProxy?: boolean; game?: GameManager }): Express {
  const app = express();
  app.disable("x-powered-by");
  if (opts.trustProxy) app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: opts.frontOrigin }));
  app.use(express.json({ limit: "8kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/rooms", roomsRouter(opts.manager));
  // Test-only helpers (forced dice, cash tweaks): mounted only when the game manager runs in test mode (NODE_ENV=test).
  if (opts.game?.testMode) app.use("/api/test", testRouter(opts.game));

  app.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });
  // Express identifies error handlers by their 4 parameters, so `next` must stay in the signature.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) console.error("[http] unhandled error:", err instanceof Error ? err.message : err);
    res.status(status).json({ error: status === 400 || status === 413 ? "VALIDATION_ERROR" : "INTERNAL" });
  };
  app.use(onError);
  return app;
}
