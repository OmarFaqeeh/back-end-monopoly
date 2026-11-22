import http from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIMINGS } from "../src/config/defaults.js";
import { createApp } from "../src/http/app.js";
import { RoomManager, type RoomSnapshot } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";
import { registerRoomHandlers } from "../src/sockets/roomHandlers.js";

let server: http.Server;
let io: Server;
let manager: RoomManager;
let url: string;
const clients: Socket[] = [];

async function start(emptyTimeoutMs = DEFAULT_TIMINGS.emptyTimeoutMs) {
  manager = new RoomManager({ repo: new InMemoryRoomRepository(), timings: { ...DEFAULT_TIMINGS, emptyTimeoutMs }, logger: { error: () => {} } });
  server = http.createServer(createApp({ manager, frontOrigin: "http://localhost:3000" }));
  io = new Server(server, { cors: { origin: "http://localhost:3000" } });
  registerRoomHandlers(io, manager);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const client = () => {
  const s = connect(url, { transports: ["websocket"], forceNew: true });
  clients.push(s);
  return s;
};
const emit = <T>(s: Socket, event: string, payload: unknown) => new Promise<T>((resolve) => s.emit(event, payload, resolve));
const once = <T>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));
async function create(nickname = "Omar") {
  const res = await fetch(`${url}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname }) });
  return (await res.json()) as { code: string; playerId: string; playerToken: string; expiresAt: number; serverNow: number };
}

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect());
  manager?.dispose();
  io?.close();
  await new Promise((r) => server?.close(r));
});

describe("socket integration", () => {
  beforeEach(async () => {
    await start();
  });

  it("host + guest full flow, host-only settings, state broadcast", async () => {
    const room = await create();
    const host = client();
    const hostJoin = await emit<{ ok: true; playerId: string; state: RoomSnapshot; playerToken?: string }>(host, "room:join", {
      code: room.code,
      nickname: "Omar",
      playerId: room.playerId,
      playerToken: room.playerToken,
    });
    expect(hostJoin.ok).toBe(true);
    expect(hostJoin.playerToken).toBeUndefined();
    expect(hostJoin.state.expiresAt).not.toBeNull();

    const hostSees = once<RoomSnapshot>(host, "room:state");
    const guest = client();
    const guestJoin = await emit<{ ok: true; playerId: string; playerToken: string; state: RoomSnapshot }>(guest, "room:join", { code: room.code, nickname: "Sara" });
    expect(guestJoin.ok).toBe(true);
    expect(guestJoin.playerToken).toBeTruthy();
    const afterJoin = await hostSees;
    expect(afterJoin.players.map((p) => p.nickname)).toEqual(["Omar", "Sara"]);
    expect(afterJoin.expiresAt).toBeNull(); // the countdown is gone for the host

    const pick = await emit<{ ok: boolean; state: RoomSnapshot }>(guest, "player:selectCharacter", { characterId: "c07" });
    expect(pick.ok).toBe(true);
    expect((await emit<{ ok: boolean; error?: string }>(host, "player:selectCharacter", { characterId: "c07" })).error).toBe("CHARACTER_TAKEN");

    expect((await emit<{ ok: boolean; error?: string }>(guest, "room:updateSettings", { patch: { auctions: false } })).error).toBe("NOT_HOST");
    const guestSees = once<RoomSnapshot>(guest, "room:state");
    expect((await emit<{ ok: boolean }>(host, "room:updateSettings", { patch: { auctions: false, maxPlayers: 3 } })).ok).toBe(true);
    expect((await guestSees).settings).toMatchObject({ auctions: false, maxPlayers: 3 });
  });

  it("validates payloads and requires a session", async () => {
    const s = client();
    expect((await emit<{ error: string }>(s, "room:join", { code: "12", nickname: "x" })).error).toBe("VALIDATION_ERROR");
    expect((await emit<{ error: string }>(s, "player:selectCharacter", { characterId: "c01" })).error).toBe("NOT_IN_ROOM");
    const room = await create();
    expect((await emit<{ error: string }>(s, "room:join", { code: "000000", nickname: "Sara" })).error).toBe("ROOM_NOT_FOUND");
    expect((await emit<{ ok: boolean }>(s, "room:join", { code: room.code, nickname: "Sara" })).ok).toBe(true);
    expect((await emit<{ error: string }>(s, "room:join", { code: room.code, nickname: "Sara2" })).error).toBe("ALREADY_JOINED");
    expect((await emit<{ error: string }>(s, "player:selectCharacter", { characterId: "zzz" })).error).toBe("VALIDATION_ERROR");
  });

  it("rate limits events per socket", async () => {
    const s = client();
    const results: string[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await emit<{ error?: string }>(s, "room:join", { code: "bad" });
      results.push(r.error ?? "ok");
    }
    expect(results.filter((r) => r === "RATE_LIMITED").length).toBeGreaterThan(0);
  });

  it("lets a player reconnect with playerId + playerToken", async () => {
    const room = await create();
    const host = client();
    await emit(host, "room:join", { code: room.code, nickname: "Omar", playerId: room.playerId, playerToken: room.playerToken });
    const guest = client();
    const first = await emit<{ playerId: string; playerToken: string }>(guest, "room:join", { code: room.code, nickname: "Sara" });
    guest.disconnect();
    const again = client();
    const back = await emit<{ ok: boolean; playerId: string; state: RoomSnapshot }>(again, "room:join", { code: room.code, nickname: "Sara", playerId: first.playerId, playerToken: first.playerToken });
    expect(back.ok).toBe(true);
    expect(back.state.players).toHaveLength(2);
    const bad = await emit<{ error: string }>(client(), "room:join", { code: room.code, nickname: "Sara", playerId: first.playerId, playerToken: "x".repeat(20) });
    expect(bad.error).toBe("INVALID_CREDENTIALS");
  });
});

describe("room:closed on expiry", () => {
  beforeEach(async () => {
    await start(250); // env-overridable timeout, shortened for the test
  });

  it("emits room:closed {reason: EXPIRED_EMPTY} to the host and frees the code", async () => {
    const room = await create();
    expect(room.expiresAt - room.serverNow).toBeLessThanOrEqual(250);
    const host = client();
    await emit(host, "room:join", { code: room.code, nickname: "Omar", playerId: room.playerId, playerToken: room.playerToken });
    const closed = await once<{ reason: string }>(host, "room:closed");
    expect(closed).toEqual({ reason: "EXPIRED_EMPTY" });
    const res = await fetch(`${url}/api/rooms/${room.code}`);
    expect(res.status).toBe(404);
  });

  it("does not close when a guest joins in time", async () => {
    const room = await create();
    const host = client();
    await emit(host, "room:join", { code: room.code, nickname: "Omar", playerId: room.playerId, playerToken: room.playerToken });
    const guest = client();
    await emit(guest, "room:join", { code: room.code, nickname: "Sara" });
    await new Promise((r) => setTimeout(r, 450));
    expect((await fetch(`${url}/api/rooms/${room.code}`)).status).toBe(200);
  });
});
