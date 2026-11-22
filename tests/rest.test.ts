import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { RoomManager } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";

let manager: RoomManager;

function build() {
  manager = new RoomManager({ repo: new InMemoryRoomRepository(), logger: { error: () => {} } });
  return createApp({ manager, frontOrigin: "http://localhost:3000" });
}

afterEach(() => manager?.dispose());

describe("POST /api/rooms", () => {
  it("creates a room: 201 with code, playerId, playerToken, expiresAt, serverNow", async () => {
    const res = await request(build()).post("/api/rooms").send({ nickname: "Omar" });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[0-9]{6}$/);
    expect(res.body.playerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof res.body.playerToken).toBe("string");
    const remaining = res.body.expiresAt - res.body.serverNow;
    expect(remaining).toBeGreaterThan(119_000);
    expect(remaining).toBeLessThanOrEqual(120_000);
  });

  it("validates input with the stable error shape", async () => {
    const app = build();
    expect((await request(app).post("/api/rooms").send({ nickname: "  " })).body).toEqual({ error: "NICKNAME_INVALID" });
    expect((await request(app).post("/api/rooms").send({ nickname: "x".repeat(17) })).status).toBe(400);
    expect((await request(app).post("/api/rooms").send({})).body).toEqual({ error: "VALIDATION_ERROR" });
    expect((await request(app).post("/api/rooms").set("Content-Type", "application/json").send("{not json")).body).toEqual({ error: "VALIDATION_ERROR" });
  });

  it("limits creations per IP", async () => {
    const app = build();
    for (let i = 0; i < 10; i++) expect((await request(app).post("/api/rooms").send({ nickname: "Omar" })).status).toBe(201);
    const res = await request(app).post("/api/rooms").send({ nickname: "Omar" });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "RATE_LIMITED" });
  });
});

describe("GET /api/rooms/:code", () => {
  it("returns the room status without player names", async () => {
    const app = build();
    const created = await request(app).post("/api/rooms").send({ nickname: "Omar" });
    const res = await request(app).get(`/api/rooms/${created.body.code}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: created.body.code, status: "waiting", playerCount: 1, maxPlayers: 4, joinable: true });
    expect(JSON.stringify(res.body)).not.toContain("Omar");
  });

  it("reports full rooms and 404s unknown or malformed codes", async () => {
    const app = build();
    const created = await request(app).post("/api/rooms").send({ nickname: "Omar" });
    await manager.updateSettings(created.body.code, created.body.playerId, { maxPlayers: 2 });
    await manager.join({ code: created.body.code, nickname: "Sara", socketId: "s" });
    expect((await request(app).get(`/api/rooms/${created.body.code}`)).body).toMatchObject({ joinable: false, reason: "ROOM_FULL" });
    expect((await request(app).get("/api/rooms/999999")).body).toEqual({ error: "ROOM_NOT_FOUND" });
    expect((await request(app).get("/api/rooms/abc")).status).toBe(404);
  });

  it("allows only 10 failed lookups per minute per IP", async () => {
    const app = build();
    for (let i = 0; i < 10; i++) expect((await request(app).get("/api/rooms/000000")).status).toBe(404);
    const res = await request(app).get("/api/rooms/000000");
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "RATE_LIMITED" });
  });

  it("limits lookups to 30 per minute per IP (successful ones do not count as failures)", async () => {
    const app = build();
    const created = await request(app).post("/api/rooms").send({ nickname: "Omar" });
    for (let i = 0; i < 30; i++) expect((await request(app).get(`/api/rooms/${created.body.code}`)).status).toBe(200);
    expect((await request(app).get(`/api/rooms/${created.body.code}`)).status).toBe(429);
  });
});

describe("security", () => {
  it("sends helmet headers and restricts CORS to the front origin", async () => {
    const app = build();
    const res = await request(app).get("/health").set("Origin", "http://localhost:3000");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const other = await request(app).get("/health").set("Origin", "http://evil.example");
    expect(other.headers["access-control-allow-origin"]).not.toBe("http://evil.example");
  });

  it("rejects oversized bodies", async () => {
    const res = await request(build()).post("/api/rooms").send({ nickname: "x".repeat(20_000) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "VALIDATION_ERROR" });
  });
});
