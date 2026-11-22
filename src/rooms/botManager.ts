// Lobby behavior of bots (before the game starts). The RoomManager owns the seats; this class decides when bots appear:
//  - Allow bots turned ON: bots fill ALL empty seats at once (maxPlayers - seated).
//  - the host removes a bot with X: if the seat is still empty after 10 s a new bot fills it, then one bot every 5 s
//    for any other seat that is still empty (a human taking a seat cancels that seat's refill).
//  - turning Allow bots OFF removes every bot and stops refills; a higher maxPlayers is refilled one bot per 5 s.
// All timers are cleared when the room closes or the game starts; reconcile() is idempotent.
import { BOT_NAMES } from "../config/botNames.js";
import { BOT_REFILL_AFTER_REMOVE_MS, BOT_REFILL_INTERVAL_MS, PERSONALITY_IDS } from "../config/botPersonalities.js";
import { CHARACTER_IDS } from "../config/characters.js";
import { nicknameKey } from "../utils/nickname.js";
import type { RoomManager } from "./roomManager.js";

interface RoomBots {
  /** Allow bots was ON at the last reconcile (so turning it ON fills everything at once, only once). */
  on: boolean;
  filling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface BotManagerOptions {
  random?: () => number;
  now?: () => number;
  refillAfterRemoveMs?: number;
  refillIntervalMs?: number;
}

export class BotManager {
  private readonly rooms = new Map<string, RoomBots>();
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly afterRemoveMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly manager: RoomManager,
    opts: BotManagerOptions = {},
  ) {
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.afterRemoveMs = opts.refillAfterRemoveMs ?? BOT_REFILL_AFTER_REMOVE_MS;
    this.intervalMs = opts.refillIntervalMs ?? BOT_REFILL_INTERVAL_MS;
    manager.addHooks({
      settingsChanged: (code) => void this.reconcile(code),
      playerJoined: (code) => void this.reconcile(code),
      playerRemoved: (code) => void this.reconcile(code),
      roomClosed: (code) => this.forget(code),
      gameStarted: (code) => this.forget(code),
    });
  }

  private state(code: string): RoomBots {
    let st = this.rooms.get(code);
    if (!st) {
      st = { on: false, filling: false, timer: null };
      this.rooms.set(code, st);
    }
    return st;
  }

  private clearTimer(code: string): void {
    const st = this.rooms.get(code);
    if (st?.timer) clearTimeout(st.timer);
    if (st) st.timer = null;
    this.manager.setBotRefillAt(code, null);
  }

  /** Stop everything for a room (closed, or the game started). */
  forget(code: string): void {
    this.clearTimer(code);
    this.rooms.delete(code);
  }

  /** Brings the bots in line with the settings and the seats. Safe to call at any time. */
  async reconcile(code: string): Promise<void> {
    const info = this.manager.seatInfo(code);
    if (!info || info.status !== "waiting") return this.forget(code);
    const st = this.state(code);
    if (st.filling) return;

    if (!info.allowBots) {
      this.clearTimer(code);
      if (st.on || info.bots > 0) this.manager.removeAllBots(code);
      st.on = false;
      return;
    }
    if (!st.on) {
      // Just turned ON: every empty seat gets a bot in the same moment.
      st.on = true;
      st.filling = true;
      try {
        for (let n = Math.max(0, info.max - info.seated); n > 0; n--) await this.addOne(code);
      } finally {
        st.filling = false;
      }
      return;
    }
    const empty = info.max - info.seated;
    if (empty <= 0) return this.clearTimer(code);
    if (!st.timer) this.schedule(code, this.intervalMs);
  }

  /** The host pressed X on a bot. The seat is refilled after 10 s (then every 5 s) unless a human takes it. */
  removeByHost(code: string, hostId: string, botId: string): boolean {
    if (!this.manager.removeBot(code, hostId, botId)) return false;
    const info = this.manager.seatInfo(code);
    const st = this.state(code);
    if (info?.allowBots && info.max - info.seated > 0 && !st.timer) this.schedule(code, this.afterRemoveMs);
    return true;
  }

  private schedule(code: string, ms: number): void {
    const st = this.state(code);
    if (st.timer) clearTimeout(st.timer);
    this.manager.setBotRefillAt(code, this.now() + ms);
    st.timer = setTimeout(() => {
      st.timer = null;
      this.manager.setBotRefillAt(code, null);
      void this.refillOne(code);
    }, ms);
    st.timer.unref?.();
  }

  private async refillOne(code: string): Promise<void> {
    const info = this.manager.seatInfo(code);
    if (!info || info.status !== "waiting" || !info.allowBots || info.seated >= info.max) return;
    await this.addOne(code);
    await this.reconcile(code); // schedules the next refill when a seat is still empty
  }

  /** A random unused male name (different from every nickname in the room, ignoring case) and a random unused character. */
  private pick(code: string): { nickname: string; characterId: string; personality: string } | null {
    const info = this.manager.seatInfo(code);
    if (!info) return null;
    const taken = new Set(info.nicknames.map(nicknameKey));
    const names = BOT_NAMES.filter((n) => !taken.has(nicknameKey(n)));
    let nickname: string = names.length ? names[Math.floor(this.random() * names.length)]! : BOT_NAMES[Math.floor(this.random() * BOT_NAMES.length)]!;
    for (let i = 2; taken.has(nicknameKey(nickname)); i++) nickname = `${nickname}${i}`;
    const free = CHARACTER_IDS.filter((c) => !info.characters.includes(c));
    if (!free.length) return null;
    return {
      nickname,
      characterId: free[Math.floor(this.random() * free.length)]!,
      personality: PERSONALITY_IDS[Math.floor(this.random() * PERSONALITY_IDS.length)]!,
    };
  }

  private async addOne(code: string): Promise<void> {
    const bot = this.pick(code);
    if (bot) await this.manager.addBot(code, bot);
  }

  dispose(): void {
    for (const st of this.rooms.values()) if (st.timer) clearTimeout(st.timer);
    this.rooms.clear();
  }
}
