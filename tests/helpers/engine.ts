// Test helpers for the engine: fixed turn order, forced dice, shortcuts for state setup.
import { applyAction } from "../../src/engine/actions.js";
import { checkInvariants, createGame } from "../../src/engine/state.js";
import type { Action, ActionResult, GameEvent, GameState } from "../../src/engine/types.js";
import type { GameRules } from "../../src/shared/settings.js";

/** Two dice that add up to `total` (2..12). */
export const dice = (total: number): [number, number] => {
  const a = Math.min(6, total - 1);
  return [a, total - a];
};

/** A game with a known turn order (ids in the given order) and `cash` each. */
export function newGame(ids = ["a", "b"], cash = 1500, seed: number | string = 1, rules: Partial<GameRules> = {}): GameState {
  const res = createGame({ players: ids.map((id, i) => ({ id, characterId: `c${String(i + 1).padStart(2, "0")}` })), startingCash: cash, rules: { auctions: false, evenBuild: false, ...rules }, seed });
  if (!res.ok) throw new Error(res.error);
  const state = res.state;
  state.players = ids.map((id) => state.players.find((p) => p.id === id)!);
  state.currentPlayerId = ids[0]!;
  return state;
}

let counter = 0;
export const id = () => `act-${++counter}`;

export interface Played {
  state: GameState;
  events: GameEvent[];
}

/** Applies an action and returns the new state, failing the test on an error or a broken invariant. */
export function ok(state: GameState, action: Omit<Action, "actionId"> & { actionId?: string }, roll?: number, now?: number): Played {
  const res = applyAction(state, { actionId: id(), ...action } as Action, { ...(roll ? { dice: () => dice(roll) } : {}), ...(now !== undefined ? { now } : {}) });
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  const problems = checkInvariants(res.state);
  if (problems.length) throw new Error(`invariants: ${problems.join("; ")}`);
  return { state: res.state, events: res.events };
}

export function fail(state: GameState, action: Omit<Action, "actionId"> & { actionId?: string }, roll?: number, now?: number): string {
  const res: ActionResult = applyAction(state, { actionId: id(), ...action } as Action, { ...(roll ? { dice: () => dice(roll) } : {}), ...(now !== undefined ? { now } : {}) });
  return res.ok ? "NO_ERROR" : res.error;
}

export const types = (events: GameEvent[]) => events.map((e) => e.type);
export const cashOf = (state: GameState, playerId: string) => state.players.find((p) => p.id === playerId)!.cash;
export const posOf = (state: GameState, playerId: string) => state.players.find((p) => p.id === playerId)!.position;
export const playerOf = (state: GameState, playerId: string) => state.players.find((p) => p.id === playerId)!;

/** Gives a player a set of tiles (level 0 unless given). */
export function own(state: GameState, playerId: string, tiles: number[], level = 0): void {
  for (const t of tiles) state.properties[t] = { ownerId: playerId, level, mortgaged: false };
}
