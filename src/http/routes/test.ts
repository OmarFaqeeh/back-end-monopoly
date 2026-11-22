// Test-only routes (mounted only when NODE_ENV=test): force the next dice and set a player's cash, so a browser run
// can walk through every rule. Never available in development or production.
import { Router } from "express";
import { z } from "zod";
import { GameError, type GameManager } from "../../game/gameManager.js";

const diceBody = z.object({ sequence: z.array(z.tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)])).min(1).max(100) });
const cashBody = z.object({ playerId: z.string().min(1), cash: z.number().int().min(0).max(1_000_000) });

export function testRouter(game: GameManager): Router {
  const router = Router();

  router.post("/rooms/:code/dice", (req, res) => {
    const body = diceBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "VALIDATION_ERROR" });
    try {
      game.setTestDice(String(req.params.code), body.data.sequence);
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: e instanceof GameError ? e.code : "INTERNAL" });
    }
  });

  router.post("/rooms/:code/cash", (req, res) => {
    const body = cashBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "VALIDATION_ERROR" });
    try {
      game.setTestCash(String(req.params.code), body.data.playerId, body.data.cash);
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: e instanceof GameError ? e.code : "INTERNAL" });
    }
  });

  router.post("/rooms/:code/afk-kick", (req, res) => {
    const body = z.object({ playerId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "VALIDATION_ERROR" });
    game.kickInactive(String(req.params.code), body.data.playerId);
    res.json({ ok: true });
  });

  return router;
}
