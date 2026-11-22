// REST routes: create a private room and check whether a room can be joined.
import { Router } from "express";
import { z } from "zod";
import { createLimiter, failedLookupLimiter, lookupLimiter } from "../../middleware/rateLimit.js";
import { RoomError, type RoomManager } from "../../rooms/roomManager.js";
import { isRoomCode } from "../../utils/roomCode.js";

const createBody = z.object({ nickname: z.string() });

export function roomsRouter(manager: RoomManager): Router {
  const router = Router();

  router.post("/", createLimiter(), async (req, res) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "VALIDATION_ERROR" });
      return;
    }
    try {
      const created = await manager.createRoom(body.data.nickname);
      res.status(201).json(created);
    } catch (e) {
      if (e instanceof RoomError) {
        res.status(e.code === "NICKNAME_INVALID" ? 400 : 503).json({ error: e.code });
        return;
      }
      throw e;
    }
  });

  router.get("/:code", lookupLimiter(), failedLookupLimiter(), (req, res) => {
    const code = String(req.params.code);
    const found = isRoomCode(code) ? manager.lookup(code) : null;
    if (!found) {
      res.status(404).json({ error: "ROOM_NOT_FOUND" });
      return;
    }
    res.json(found);
  });

  return router;
}
