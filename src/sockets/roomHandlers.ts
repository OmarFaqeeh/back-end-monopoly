// Socket.IO room events (zod-validated, all with acks) and the bridge from RoomManager events to rooms.
import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { CHARACTER_IDS } from "../config/characters.js";
import { GameError, GameManager } from "../game/gameManager.js";
import type { BotManager } from "../rooms/botManager.js";
import { RoomError, type ChatMessage, type RoomManager, type RoomSnapshot } from "../rooms/roomManager.js";

export const ClientEvents = {
  join: "room:join",
  selectCharacter: "player:selectCharacter",
  updateSettings: "room:updateSettings",
  leave: "room:leave",
  chat: "chat:send",
  removeBot: "room:removeBot",
  gameStart: "game:start",
  gameRoll: "game:roll",
  gameBuy: "game:buy",
  gameSkip: "game:skip",
  gameJailPay: "game:jailPay",
  gameJailStay: "game:jailStay",
  gameBuild: "game:build",
  gameResign: "game:resign",
  gameBid: "game:bid",
  gameWithdraw: "game:withdraw",
  gameMortgage: "game:mortgage",
  gameUnmortgage: "game:unmortgage",
  gamePayDebt: "game:payDebt",
  gameDeclareBankruptcy: "game:declareBankruptcy",
  gameProposeTrade: "game:proposeTrade",
  gameAcceptTrade: "game:acceptTrade",
  gameRejectTrade: "game:rejectTrade",
  gameCancelTrade: "game:cancelTrade",
} as const;

export const ServerEvents = { state: "room:state", closed: "room:closed", chat: "chat:message", gameStarted: "game:started", gameEvents: "game:events", gameSync: "game:sync", gameOver: "game:over" } as const;

const joinSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
  nickname: z.string().max(64),
  playerId: z.string().uuid().optional(),
  playerToken: z.string().min(10).max(200).optional(),
});
const selectSchema = z.object({ characterId: z.enum(CHARACTER_IDS) });
const settingsSchema = z.object({ patch: z.record(z.string(), z.unknown()) });
// Length is checked (after cleaning) by the manager; this only bounds the payload size.
const chatSchema = z.object({ text: z.string().max(1000) });
const actionSchema = z.object({ actionId: z.string().min(1).max(64) });
const buildSchema = actionSchema.extend({ tileIndex: z.number().int().min(0).max(39), kind: z.enum(["house", "hotel"]) });
const bidSchema = actionSchema.extend({ amount: z.number().int().min(1).max(1_000_000) });
const tileActionSchema = actionSchema.extend({ tileIndex: z.number().int().min(0).max(39) });
const tradeSideSchema = z.object({ tiles: z.array(z.number().int().min(0).max(39)).max(40), cash: z.number().int().min(0).max(1_000_000) });
const proposeTradeSchema = actionSchema.extend({ toId: z.string().min(1).max(64), give: tradeSideSchema, get: tradeSideSchema });
const tradeIdSchema = actionSchema.extend({ tradeId: z.string().min(1).max(32) });
const startSchema = z.object({ actionId: z.string().max(64).optional() }).optional();

export type Ack =
  | { ok: true; playerId?: string; playerToken?: string; state: RoomSnapshot; messages?: ChatMessage[] }
  | { ok: false; error: string };

interface Session {
  code: string;
  playerId: string;
}

const EVENTS_PER_WINDOW = 20;
const WINDOW_MS = 10_000;

const roomChannel = (code: string) => `room:${code}`;

function reply(ack: unknown, response: unknown): void {
  if (typeof ack === "function") ack(response);
}

export function registerRoomHandlers(io: Server, manager: RoomManager, game: GameManager = new GameManager({ manager }), bots?: BotManager): void {
  game.emitter = {
    started: (code, snapshot, turnTimer) => void io.to(roomChannel(code)).emit(ServerEvents.gameStarted, { snapshot, turnTimer: turnTimer ?? null }),
    events: (code, payload) => void io.to(roomChannel(code)).emit(ServerEvents.gameEvents, payload),
    over: (code, winnerPlayerId) => void io.to(roomChannel(code)).emit(ServerEvents.gameOver, { winnerPlayerId }),
  };
  manager.events = {
    state: (snapshot) => {
      io.to(roomChannel(snapshot.code)).emit(ServerEvents.state, snapshot);
    },
    chat: (code, message) => {
      io.to(roomChannel(code)).emit(ServerEvents.chat, message);
    },
    closed: (code, reason) => {
      io.to(roomChannel(code)).emit(ServerEvents.closed, { reason });
      io.in(roomChannel(code)).socketsLeave(roomChannel(code));
    },
  };

  io.on("connection", (socket: Socket) => {
    let session: Session | null = null;
    const stamps: number[] = [];
    const allowed = () => {
      const now = Date.now();
      while (stamps.length && now - stamps[0]! > WINDOW_MS) stamps.shift();
      if (stamps.length >= EVENTS_PER_WINDOW) return false;
      stamps.push(now);
      return true;
    };

    /** Wraps a handler: rate limit, validation errors and RoomError mapping in one place. */
    const handle = <T>(event: string, schema: z.ZodType<T>, run: (data: T, ack: unknown) => Promise<void>) => {
      socket.on(event, async (payload: unknown, ack?: unknown) => {
        if (!allowed()) return reply(ack, { ok: false, error: "RATE_LIMITED" });
        const parsed = schema.safeParse(payload);
        if (!parsed.success) return reply(ack, { ok: false, error: "VALIDATION_ERROR" });
        try {
          await run(parsed.data, ack);
        } catch (e) {
          if (e instanceof RoomError || e instanceof GameError) return reply(ack, { ok: false, error: e.code });
          console.error(`[socket] ${event} failed:`, e instanceof Error ? e.message : e);
          reply(ack, { ok: false, error: "INTERNAL" });
        }
      });
    };

    handle(ClientEvents.join, joinSchema, async (data, ack) => {
      if (session) return reply(ack, { ok: false, error: "ALREADY_JOINED" });
      const result = await manager.join({ ...data, socketId: socket.id });
      session = { code: data.code, playerId: result.playerId };
      await socket.join(roomChannel(data.code));
      const response: Ack = {
        ok: true,
        playerId: result.playerId,
        state: result.snapshot,
        messages: manager.getMessages(data.code),
        ...(result.playerToken ? { playerToken: result.playerToken } : {}),
      };
      reply(ack, response);
      // A player (re)joining a running game gets the full snapshot, without replaying old events.
      const running = game.getSnapshot(data.code);
      if (running) socket.emit(ServerEvents.gameSync, { snapshot: running, turnTimer: game.getTurnTimer(data.code) });
    });

    /** Registers a game action: needs a session, then the game manager applies it for this player. */
    const gameAction = <T extends { actionId: string }>(event: string, schema: z.ZodType<T>, build: (data: T) => Parameters<GameManager["act"]>[2]) =>
      handle(event, schema, async (data, ack) => {
        if (!session) throw new RoomError("NOT_IN_ROOM");
        game.act(session.code, session.playerId, build(data));
        reply(ack, { ok: true });
      });

    handle(ClientEvents.gameStart, startSchema, async (_data, ack) => {
      if (!session) throw new RoomError("NOT_IN_ROOM");
      game.start(session.code, session.playerId);
      reply(ack, { ok: true });
    });
    gameAction(ClientEvents.gameRoll, actionSchema, (d) => ({ actionId: d.actionId, type: "roll" }));
    gameAction(ClientEvents.gameBuy, actionSchema, (d) => ({ actionId: d.actionId, type: "buy" }));
    gameAction(ClientEvents.gameSkip, actionSchema, (d) => ({ actionId: d.actionId, type: "skip" }));
    gameAction(ClientEvents.gameJailPay, actionSchema, (d) => ({ actionId: d.actionId, type: "jailPay" }));
    gameAction(ClientEvents.gameJailStay, actionSchema, (d) => ({ actionId: d.actionId, type: "jailStay" }));
    gameAction(ClientEvents.gameBid, bidSchema, (d) => ({ actionId: d.actionId, type: "bid", amount: d.amount }));
    gameAction(ClientEvents.gameWithdraw, actionSchema, (d) => ({ actionId: d.actionId, type: "withdraw" }));
    gameAction(ClientEvents.gameMortgage, tileActionSchema, (d) => ({ actionId: d.actionId, type: "mortgage", tileIndex: d.tileIndex }));
    gameAction(ClientEvents.gameUnmortgage, tileActionSchema, (d) => ({ actionId: d.actionId, type: "unmortgage", tileIndex: d.tileIndex }));
    gameAction(ClientEvents.gamePayDebt, actionSchema, (d) => ({ actionId: d.actionId, type: "payDebt" }));
    gameAction(ClientEvents.gameDeclareBankruptcy, actionSchema, (d) => ({ actionId: d.actionId, type: "declareBankruptcy" }));
    gameAction(ClientEvents.gameResign, actionSchema, (d) => ({ actionId: d.actionId, type: "resign" }));
    gameAction(ClientEvents.gameProposeTrade, proposeTradeSchema, (d) => ({ actionId: d.actionId, type: "proposeTrade", toId: d.toId, give: d.give, get: d.get }));
    gameAction(ClientEvents.gameAcceptTrade, tradeIdSchema, (d) => ({ actionId: d.actionId, type: "acceptTrade", tradeId: d.tradeId }));
    gameAction(ClientEvents.gameRejectTrade, tradeIdSchema, (d) => ({ actionId: d.actionId, type: "rejectTrade", tradeId: d.tradeId }));
    gameAction(ClientEvents.gameCancelTrade, tradeIdSchema, (d) => ({ actionId: d.actionId, type: "cancelTrade", tradeId: d.tradeId }));
    gameAction(ClientEvents.gameBuild, buildSchema, (d) => ({ actionId: d.actionId, type: "build", tileIndex: d.tileIndex, kind: d.kind }));

    handle(ClientEvents.selectCharacter, selectSchema, async (data, ack) => {
      if (!session) throw new RoomError("NOT_IN_ROOM");
      const state = await manager.selectCharacter(session.code, session.playerId, data.characterId);
      reply(ack, { ok: true, state });
    });

    handle(ClientEvents.updateSettings, settingsSchema, async (data, ack) => {
      if (!session) throw new RoomError("NOT_IN_ROOM");
      const state = await manager.updateSettings(session.code, session.playerId, data.patch);
      reply(ack, { ok: true, state });
    });

    handle(ClientEvents.removeBot, z.object({ playerId: z.string().min(1).max(64) }), async (data, ack) => {
      if (!session) throw new RoomError("NOT_IN_ROOM");
      if (!bots?.removeByHost(session.code, session.playerId, data.playerId)) throw new RoomError("NOT_HOST");
      reply(ack, { ok: true });
    });

    handle(ClientEvents.chat, chatSchema, async (data, ack) => {
      if (!session) throw new RoomError("NOT_IN_ROOM");
      const message = manager.sendChat(session.code, session.playerId, data.text);
      reply(ack, { ok: true, message });
    });

    handle(ClientEvents.leave, z.unknown(), async (_data, ack) => {
      if (!session) throw new RoomError("NOT_IN_ROOM");
      const { code, playerId } = session;
      session = null;
      await manager.leave(code, playerId);
      await socket.leave(roomChannel(code));
      reply(ack, { ok: true });
    });

    socket.on("disconnect", () => {
      if (session) manager.disconnect(session.code, session.playerId, socket.id);
    });
  });
}
