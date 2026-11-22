// Self-check: insert, select, update and delete a temporary room through the real repository.
// Usage: npm run check:supabase (reads back/.env). Prints OK or a clear error. Never prints secrets.
import "dotenv/config";
import { loadEnv, EnvError } from "../src/config/env.js";
import { DEFAULT_SETTINGS } from "../src/config/settings.js";
import { createSupabase } from "../src/services/supabase.js";
import { SupabaseRoomRepository } from "../src/services/supabaseRoomRepository.js";
import { generateRoomCode } from "../src/utils/roomCode.js";
import { hashToken, newPlayerId } from "../src/utils/token.js";

async function main() {
  const env = loadEnv();
  const repo = new SupabaseRoomRepository(createSupabase(env));
  const code = generateRoomCode();
  const hostId = newPlayerId();
  let roomId: string | null = null;
  try {
    const room = await repo.createRoom({ code, hostPlayerId: hostId, settings: DEFAULT_SETTINGS, expiresAt: new Date(Date.now() + 60_000) });
    roomId = room.id;
    console.log("insert room ... ok");
    await repo.addPlayer({ roomId, playerId: hostId, tokenHash: hashToken("check"), nickname: "check", isHost: true });
    console.log("insert player ... ok");
    const found = await repo.getActiveByCode(code);
    if (found?.id !== roomId) throw new Error("select returned a different room");
    console.log("select ... ok");
    await repo.updateRoom(roomId, { settings: { ...DEFAULT_SETTINGS, maxPlayers: 6 } });
    await repo.updatePlayer(roomId, hostId, { characterId: "c01" });
    const updated = await repo.getActiveByCode(code);
    if (updated?.settings.maxPlayers !== 6) throw new Error("update did not persist");
    console.log("update ... ok");
  } finally {
    if (roomId) {
      await repo.deleteRoom(roomId);
      console.log("delete ... ok");
    }
  }
  console.log("OK: Supabase is reachable and the tables work.");
}

main().catch((e) => {
  if (e instanceof EnvError) console.error(e.message);
  else console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}\nCheck SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and that 0001_rooms.sql was run.`);
  process.exit(1);
});
