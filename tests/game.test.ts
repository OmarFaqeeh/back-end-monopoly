// Socket integration: an in-process server and real socket.io clients play through the game events.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIMINGS } from "../src/config/defaults.js";
import { GameManager } from "../src/game/gameManager.js";
import { createApp } from "../src/http/app.js";
import { RoomManager } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";
import { registerRoomHandlers } from "../src/sockets/roomHandlers.js";
import { applyBatch } from "../src/shared/display.js";
import type { GameEvent, GameEventsPayload, GameSnapshot } from "../src/shared/events.js";
import { dice } from "./helpers/engine.js";

let server: http.Server;
let io: Server;
let manager: RoomManager;
let game: GameManager;
let url: string;
const sockets: Socket[] = [];

async function boot(timings = DEFAULT_TIMINGS) {
  manager = new RoomManager({ repo: new InMemoryRoomRepository(), timings, logger: { error: () => {} } });
  game = new GameManager({ manager, timings, testMode: true, logger: { error: () => {} } });
  server = http.createServer(createApp({ manager, frontOrigin: "http://localhost:3000", game }));
  io = new Server(server, { cors: { origin: "http://localhost:3000" } });
  registerRoomHandlers(io, manager, game);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  game?.dispose();
  manager?.dispose();
  io?.close();
  await new Promise((r) => server?.close(r));
});

type Ack = { ok: boolean; error?: string; [k: string]: unknown };
const emit = <T = Ack>(s: Socket, event: string, payload: unknown = {}) => new Promise<T>((resolve) => s.emit(event, payload, resolve));
let actionCounter = 0;
const aid = () => ({ actionId: `t-${++actionCounter}` });

interface Seat {
  id: string;
  token: string;
  socket: Socket;
  events: GameEvent[];
  snapshots: GameSnapshot[];
  syncs: GameSnapshot[];
  over: string[];
}

function wire(socket: Socket, seat: Seat) {
  socket.on("game:events", (p: GameEventsPayload) => {
    seat.events.push(...p.events);
    seat.snapshots.push(p.snapshot);
  });
  socket.on("game:sync", (p: { snapshot: GameSnapshot }) => seat.syncs.push(p.snapshot));
  socket.on("game:started", (p: { snapshot: GameSnapshot }) => seat.snapshots.push(p.snapshot));
  socket.on("game:over", (p: { winnerPlayerId: string }) => seat.over.push(p.winnerPlayerId));
}

async function room(names: string[]): Promise<{ code: string; seats: Seat[] }> {
  const res = await fetch(`${url}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: names[0] }) });
  const created = (await res.json()) as { code: string; playerId: string; playerToken: string };
  const seats: Seat[] = [];
  for (const [i, name] of names.entries()) {
    const socket = connect(url, { transports: ["websocket"], forceNew: true });
    sockets.push(socket);
    const seat: Seat = { id: "", token: "", socket, events: [], snapshots: [], syncs: [], over: [] };
    wire(socket, seat);
    const join = await emit<Ack & { playerId: string; playerToken?: string }>(
      socket,
      "room:join",
      i === 0 ? { code: created.code, nickname: name, playerId: created.playerId, playerToken: created.playerToken } : { code: created.code, nickname: name },
    );
    seat.id = join.playerId;
    seat.token = i === 0 ? created.playerToken : join.playerToken!;
    expect((await emit(socket, "player:selectCharacter", { characterId: `c0${i + 1}` })).ok).toBe(true);
    seats.push(seat);
  }
  // These socket tests are about turns and trades: switch off the rules that would add auctions or even-build limits.
  await manager.updateSettings(created.code, created.playerId, { auctions: false, evenBuild: false });
  return { code: created.code, seats };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await wait(10);
  }
}

describe("starting a game", () => {
  beforeEach(() => boot());

  it("only the host can start, needs 2 ready players, freezes the settings and refuses new joins", async () => {
    const { code, seats } = await room(["Omar", "Sara"]);
    const [host, guest] = seats as [Seat, Seat];
    expect(await emit(guest.socket, "game:start")).toMatchObject({ ok: false, error: "NOT_HOST" });
    expect(await emit(host.socket, "game:roll", aid())).toMatchObject({ ok: false, error: "GAME_NOT_STARTED" });

    expect(await emit(host.socket, "game:start")).toEqual({ ok: true });
    await until(() => guest.snapshots.length > 0);
    expect(guest.snapshots[0]!.phase).toBe("awaitingRoll");
    expect(JSON.stringify(guest.snapshots[0])).not.toMatch(/seed|"rng"|"decks"/);
    expect(await emit(host.socket, "game:start")).toMatchObject({ ok: false, error: "GAME_ALREADY_STARTED" });
    expect(await emit(host.socket, "room:updateSettings", { patch: { startingCash: 2000 } })).toMatchObject({ ok: false, error: "NOT_ALLOWED_IN_GAME" });

    const late = connect(url, { transports: ["websocket"], forceNew: true });
    sockets.push(late);
    expect(await emit(late, "room:join", { code, nickname: "Late" })).toMatchObject({ ok: false, error: "GAME_STARTED" });
  });

  it("needs two seated players", async () => {
    const { seats } = await room(["Omar"]);
    expect(await emit(seats[0]!.socket, "game:start")).toMatchObject({ ok: false, error: "NEED_2_PLAYERS" });
  });
});

describe("playing a full game over sockets", () => {
  beforeEach(() => boot());

  it("buy, skip, rent, card, tax, bankruptcy, resign by leaving, winner; every client ends on the same snapshot", async () => {
    const { code, seats } = await room(["Omar", "Sara", "Lina"]);
    await emit(seats[0]!.socket, "game:start");
    await until(() => seats.every((s) => s.snapshots.length > 0));
    const byId = new Map(seats.map((s) => [s.id, s]));
    const snap = () => game.getSnapshot(code)!;
    const act = async (event: string, extra: object = {}) => {
      const cur = byId.get(snap().currentPlayerId!)!;
      return emit(cur.socket, event, { ...aid(), ...extra });
    };
    const roll = async (total: number) => {
      game.setTestDice(code, [dice(total)]);
      return act("game:roll");
    };
    const order = snap().players.map((p) => p.id);
    const [x1, x2, x3] = order as [string, string, string];
    const cash = (id: string) => snap().players.find((p) => p.id === id)!.cash;

    // Wrong turn and wrong phase are rejected over the wire.
    expect(await emit(byId.get(x2)!.socket, "game:roll", aid())).toMatchObject({ ok: false, error: "NOT_YOUR_TURN" });
    expect(await act("game:buy")).toMatchObject({ ok: false, error: "WRONG_PHASE" });

    expect((await roll(3)).ok).toBe(true); // x1 lands on tile 3
    expect(snap().phase).toBe("awaitingDecision");
    expect((await act("game:buy")).ok).toBe(true);
    expect(cash(x1)).toBe(1450);

    expect((await roll(3)).ok).toBe(true); // x2 pays rent 6 to x1
    expect(cash(x2)).toBe(1494);
    expect(cash(x1)).toBe(1456);

    expect((await roll(2)).ok).toBe(true); // x3 on the vault: a card is drawn
    await until(() => seats[0]!.events.some((e) => e.type === "CARD_DRAWN" && e.playerId === x3));

    expect((await roll(12)).ok).toBe(true); // x1 3 -> 15 harbor
    expect((await act("game:skip")).ok).toBe(true);
    expect((await roll(12)).ok).toBe(true); // x2 3 -> 15 harbor
    expect((await act("game:buy")).ok).toBe(true); // x2 owns the harbor
    expect((await roll(2)).ok).toBe(true); // x3 (vault 2) -> 4 tax
    await until(() => seats[0]!.events.some((e) => e.type === "TAX_PAID" && e.playerId === x3));

    // x1 cannot build without the whole set.
    expect(await emit(byId.get(x1)!.socket, "game:build", { ...aid(), tileIndex: 3, kind: "house" })).toMatchObject({ ok: false, error: "SET_INCOMPLETE" });

    // x1 and x2 take harmless turns; then x3 (broke) pays x2's harbor rent and goes bankrupt.
    game.setTestCash(code, x3, 10);
    expect((await roll(2)).ok).toBe(true); // x1 15 -> 17 vault
    expect((await roll(2)).ok).toBe(true); // x2 15 -> 17 vault
    expect((await roll(11)).ok).toBe(true); // x3 4 -> 15, x2's harbor, rent 25 > 10 cash
    expect(snap().players.find((p) => p.id === x3)!.bankrupt).toBe(true);
    await until(() => seats[1]!.events.some((e) => e.type === "BANKRUPT" && e.playerId === x3));
    expect(snap().phase).not.toBe("gameOver");

    // x1 presses Leave: that is a resignation, so x2 wins.
    expect((await emit(byId.get(x1)!.socket, "room:leave")).ok).toBe(true);
    await until(() => seats.every((s) => s.over.length > 0));
    expect(seats.map((s) => s.over[0])).toEqual([x2, x2, x2]);
    expect(snap().winnerPlayerId).toBe(x2);

    // The final snapshot every client received is identical, and replaying the events reproduces it.
    const finals = seats.map((s) => s.snapshots.at(-1)!);
    expect(finals[0]).toEqual(finals[1]);
    expect(finals[1]).toEqual(finals[2]);
    expect(finals[0]).toEqual(snap());
    const replay = applyBatch(seats[0]!.snapshots[0]!, seats[0]!.events, snap().seq); // game:started snapshot + every later event
    expect(replay).toEqual(snap());
  });

  it("rejects duplicate action ids and bad payloads", async () => {
    const { code, seats } = await room(["Omar", "Sara"]);
    await emit(seats[0]!.socket, "game:start");
    await until(() => seats.every((s) => s.snapshots.length > 0));
    const cur = seats.find((s) => s.id === game.getSnapshot(code)!.currentPlayerId)!;
    game.setTestDice(code, [dice(5)]);
    const once = { actionId: "dup-1" };
    expect((await emit(cur.socket, "game:roll", once)).ok).toBe(true);
    expect(await emit(cur.socket, "game:roll", once)).toMatchObject({ ok: false, error: "DUPLICATE_ACTION" });
    expect(await emit(cur.socket, "game:roll", {})).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    expect(await emit(cur.socket, "game:build", { ...aid(), tileIndex: 400, kind: "house" })).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
  });
});

describe("reconnect and AFK", () => {
  beforeEach(() => boot({ ...DEFAULT_TIMINGS, afkTimeoutMs: 150, afkStepMs: 40 }));

  it("a player who reconnects mid-game gets the current snapshot (game:sync) and keeps playing", async () => {
    const { code, seats } = await room(["Omar", "Sara"]);
    await emit(seats[0]!.socket, "game:start");
    await until(() => seats.every((s) => s.snapshots.length > 0));
    const guest = seats.find((s) => s.id !== game.getSnapshot(code)!.currentPlayerId)!;

    guest.socket.disconnect();
    const cur = seats.find((s) => s !== guest)!;
    game.setTestDice(code, [dice(3)]);
    await emit(cur.socket, "game:roll", aid());
    await emit(cur.socket, "game:buy", aid());

    const again = connect(url, { transports: ["websocket"], forceNew: true });
    sockets.push(again);
    const fresh: Seat = { ...guest, socket: again, events: [], snapshots: [], syncs: [], over: [] };
    wire(again, fresh);
    const join = await emit(again, "room:join", { code, nickname: "Sara", playerId: guest.id, playerToken: guest.token });
    expect(join.ok).toBe(true);
    await until(() => fresh.syncs.length > 0);
    expect(fresh.syncs[0]).toEqual(game.getSnapshot(code));
    expect(fresh.syncs[0]!.properties[3]).toMatchObject({ ownerId: cur.id });
    expect(fresh.events).toEqual([]); // nothing is replayed

    game.setTestDice(code, [dice(2)]);
    expect((await emit(again, "game:roll", aid())).ok).toBe(true);
  });

  it("plays for the current player after AFK_TIMEOUT: roll, decline the purchase, then the turn moves on", async () => {
    const { code, seats } = await room(["Omar", "Sara"]);
    await emit(seats[0]!.socket, "game:start");
    await until(() => seats.every((s) => s.snapshots.length > 0));
    const first = game.getSnapshot(code)!.currentPlayerId!;
    const away = seats.find((s) => s.id === first)!;
    const stay = seats.find((s) => s.id !== first)!;
    game.setTestDice(code, [dice(3)]); // tile 3: an unowned property, so the AFK player must decline
    away.socket.disconnect();

    await until(() => stay.events.some((e) => e.type === "PROPERTY_SKIPPED" && e.playerId === first), 4000);
    expect(stay.events.some((e) => e.type === "DICE_ROLLED" && e.playerId === first)).toBe(true);
    expect(game.getSnapshot(code)!.properties[3]).toBeUndefined(); // never bought
    expect(game.getSnapshot(code)!.currentPlayerId).toBe(stay.id);
  });

  it("an AFK player who cannot pay loses by bankruptcy and the game ends", async () => {
    const { code, seats } = await room(["Omar", "Sara"]);
    await emit(seats[0]!.socket, "game:start");
    await until(() => seats.every((s) => s.snapshots.length > 0));
    const away = seats.find((s) => s.id === game.getSnapshot(code)!.currentPlayerId)!;
    const stay = seats.find((s) => s !== away)!;
    // The AFK player cannot afford the tax on tile 4, so the server-played turn ends in bankruptcy and a winner.
    game.setTestCash(code, away.id, 30);
    away.socket.disconnect();
    game.setTestDice(code, [dice(4)]); // tile 4: tax 200 > 30 -> bankrupt, game over
    await until(() => stay.over.length > 0, 4000);
    expect(stay.over[0]).toBe(stay.id);
  });
});

describe("trading and withdrawing over sockets", () => {
  beforeEach(() => boot());

  it("offer -> visible to everyone -> accept swaps the tile and the cash; withdrawing ends the game for the last player", async () => {
    const { code, seats } = await room(["Omar", "Sara", "Lina"]);
    await emit(seats[0]!.socket, "game:start");
    await until(() => seats.every((s) => s.snapshots.length > 0));
    const byId = new Map(seats.map((s) => [s.id, s]));
    const snap = () => game.getSnapshot(code)!;
    const [x1, x2, x3] = snap().players.map((p) => p.id) as [string, string, string];
    const sock = (id: string) => byId.get(id)!.socket;

    // x1 lands on tile 3 and buys it.
    game.setTestDice(code, [dice(3)]);
    expect((await emit(sock(x1), "game:roll", aid())).ok).toBe(true);
    expect((await emit(sock(x1), "game:buy", aid())).ok).toBe(true);

    // x2 (not on turn) offers 100 $ for tile 3. Everybody sees the offer, including x3 who is not involved.
    const offer = await emit<Ack & { ok: boolean }>(sock(x2), "game:proposeTrade", { ...aid(), toId: x1, give: { tiles: [], cash: 100 }, get: { tiles: [3], cash: 0 } });
    expect(offer.ok).toBe(true);
    await until(() => seats.every((s) => s.events.some((e) => e.type === "TRADE_PROPOSED")));
    expect(snap().trades).toMatchObject([{ id: "T1", fromId: x2, toId: x1, status: "pending" }]);

    // Wrong people cannot answer; bad payloads are refused.
    expect(await emit(sock(x3), "game:acceptTrade", { ...aid(), tradeId: "T1" })).toMatchObject({ ok: false, error: "NOT_TRADE_PARTY" });
    expect(await emit(sock(x2), "game:acceptTrade", { ...aid(), tradeId: "T1" })).toMatchObject({ ok: false, error: "NOT_TRADE_PARTY" });
    expect(await emit(sock(x2), "game:proposeTrade", { ...aid(), toId: x1, give: { tiles: [999], cash: 0 }, get: { tiles: [], cash: 0 } })).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });

    const cashBefore = Object.fromEntries(snap().players.map((p) => [p.id, p.cash]));
    expect((await emit(sock(x1), "game:acceptTrade", { ...aid(), tradeId: "T1" })).ok).toBe(true);
    expect(snap().properties[3]).toEqual({ ownerId: x2, level: 0, mortgaged: false });
    expect(snap().players.find((p) => p.id === x2)!.cash).toBe(cashBefore[x2]! - 100);
    expect(snap().players.find((p) => p.id === x1)!.cash).toBe(cashBefore[x1]! + 100);
    expect(snap().trades[0]!.status).toBe("accepted");

    // A second offer is rejected by its recipient; withdrawing (resign) works for a player who is not on turn.
    await emit(sock(x3), "game:proposeTrade", { ...aid(), toId: x2, give: { tiles: [], cash: 5 }, get: { tiles: [3], cash: 0 } });
    expect((await emit(sock(x2), "game:rejectTrade", { ...aid(), tradeId: "T2" })).ok).toBe(true);
    expect(snap().trades[1]!.status).toBe("rejected");

    expect((await emit(sock(x3), "game:resign", aid())).ok).toBe(true);
    expect(snap().players.find((p) => p.id === x3)!.bankrupt).toBe(true);
    expect(snap().phase).not.toBe("gameOver");
    expect((await emit(sock(x2), "game:resign", aid())).ok).toBe(true);
    await until(() => seats.every((s) => s.over.length > 0));
    expect(seats.map((s) => s.over[0])).toEqual([x1, x1, x1]); // the last player standing wins
    expect(snap().winnerPlayerId).toBe(x1);
  });
});

describe("removal for inactivity over sockets", () => {
  beforeEach(() => boot());

  it("the removed player's tiles are released to the bank at once, the others see PROPERTY_RELEASED, and another player can buy one right after", async () => {
    const { code, seats } = await room(["Omar", "Sara", "Lina"]);
    await emit(seats[0]!.socket, "game:start");
    await until(() => seats.every((s) => s.snapshots.length > 0));
    const byId = new Map(seats.map((s) => [s.id, s]));
    const first = byId.get(game.getSnapshot(code)!.currentPlayerId!)!;
    game.setTestDice(code, [dice(3)]);
    await emit(first.socket, "game:roll", aid());
    expect((await emit(first.socket, "game:buy", aid())).ok).toBe(true);
    const snapBefore = game.getSnapshot(code)!;
    expect(snapBefore.properties[3]).toMatchObject({ ownerId: first.id });
    const second = byId.get(snapBefore.currentPlayerId!)!;
    const cashBefore = snapBefore.players.find((p) => p.id === second.id)!.cash;

    game.kickInactive(code, first.id);
    await until(() => second.events.some((e) => e.type === "PROPERTY_RELEASED"));
    const released = second.events.find((e) => e.type === "PROPERTY_RELEASED");
    expect(released).toMatchObject({ playerId: first.id, tiles: [3] });
    const after = game.getSnapshot(code)!;
    expect(after.properties[3]).toBeUndefined();
    expect(after.players.find((p) => p.id === first.id)).toMatchObject({ bankrupt: true, cash: 0 });
    expect(after.currentPlayerId).toBe(second.id); // the turn did not move: the removed player was not on turn

    game.setTestDice(code, [dice(3)]);
    expect((await emit(second.socket, "game:roll", aid())).ok).toBe(true);
    expect((await emit(second.socket, "game:buy", aid())).ok).toBe(true);
    const end = game.getSnapshot(code)!;
    expect(end.properties[3]).toMatchObject({ ownerId: second.id, level: 0 });
    expect(end.players.find((p) => p.id === second.id)!.cash).toBe(cashBefore - 50);
    // every client agrees with the server after the kick and the purchase
    const rest = seats.filter((x) => x.id !== first.id);
    await until(() => rest.every((s) => s.snapshots.at(-1)?.seq === end.seq));
    for (const s of rest) expect(s.snapshots.at(-1)).toEqual(end);
  });
});
