// Default room timings and limits. Timings can be overridden (tests, env) through RoomTimings.
export interface RoomTimings {
  /** Room is closed this long after creation if nobody else joined. */
  emptyTimeoutMs: number;
  /** A disconnected guest keeps their seat this long. */
  guestGraceMs: number;
  /** A disconnected host keeps the host role this long before it is transferred. */
  hostGraceMs: number;
  /** A room with zero connected players is closed after this long. */
  zeroConnectedCloseMs: number;
  /** In a game, the server plays for the current player once they have been disconnected this long. */
  afkTimeoutMs: number;
  /** Pause between two automatic AFK actions, so clients can follow. */
  afkStepMs: number;
  /** A player whose turn is waiting for them is removed for inactivity after this long without any action. */
  turnIdleKickMs: number;
}

export const ROOM_EMPTY_TIMEOUT_MS = 120_000;
export const AFK_TIMEOUT_MS = 20_000;

export const DEFAULT_TIMINGS: RoomTimings = {
  emptyTimeoutMs: ROOM_EMPTY_TIMEOUT_MS,
  guestGraceMs: 15_000,
  hostGraceMs: 60_000,
  zeroConnectedCloseMs: 60_000,
  afkTimeoutMs: AFK_TIMEOUT_MS,
  afkStepMs: 1_200,
  turnIdleKickMs: 120_000,
};

export const JANITOR_INTERVAL_MS = 30_000;
export const NICKNAME_MAX = 16;
export const MAX_CODE_ATTEMPTS = 12;
