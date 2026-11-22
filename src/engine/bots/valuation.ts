// How much a tile is worth to a player. Pure and deterministic; reused by buying, auctions and trades.
//
// value = list price
//       + progress bonus   (0.4 x price x share of the OTHER tiles of its country the player already owns)
//       + completion bonus (0.6 x price when this tile would complete the player's set; more when sets pay double)
//       + blocking bonus   (0.5 x price when one opponent holds every other tile of the country: taking it denies the set)
//       + expected rent    (4 x base rent for a property; harbor and utility rent by how many the player would own)
import type { GameSnapshot } from "../../shared/events.js";
import { GROUPS, HARBOR_TILES, UTILITY_TILES, harborRent, rentLevels, tileAt, utilityRent } from "../../shared/rent.js";

export const VALUE = { progress: 0.4, completion: 0.6, completionDouble: 0.2, block: 0.5, rentTurns: 4 } as const;

const ownedBy = (snap: GameSnapshot, id: string, tiles: readonly number[]) => tiles.filter((i) => snap.properties[i]?.ownerId === id).length;

/** The other tiles of this tile's country, and how many of them the player owns. */
export function groupInfo(snap: GameSnapshot, playerId: string, tileIndex: number): { others: number[]; owned: number; completes: boolean; blocks: boolean } {
  const tile = tileAt(tileIndex);
  const others = tile.kind === "property" ? (GROUPS[tile.group!] ?? []).filter((i) => i !== tileIndex) : [];
  const owned = ownedBy(snap, playerId, others);
  const completes = others.length > 0 && owned === others.length;
  // An opponent who owns all the other tiles of the country is one tile from a set.
  let blocks = false;
  if (others.length > 0) {
    const holders = new Set(others.map((i) => snap.properties[i]?.ownerId));
    const holder = holders.size === 1 ? [...holders][0] : undefined;
    blocks = !!holder && holder !== playerId && others.every((i) => snap.properties[i]?.ownerId === holder);
  }
  return { others, owned, completes, blocks };
}

/** What the tile is worth to `playerId` (whether they own it already or would receive it). */
export function tileValue(snap: GameSnapshot, tileIndex: number, playerId: string): number {
  const tile = tileAt(tileIndex);
  const price = tile.price ?? 0;
  if (tile.kind === "harbor") {
    const count = ownedBy(snap, playerId, HARBOR_TILES.filter((i) => i !== tileIndex)) + 1;
    return price + harborRent(count) * 4;
  }
  if (tile.kind === "utility") {
    const count = ownedBy(snap, playerId, UTILITY_TILES.filter((i) => i !== tileIndex)) + 1;
    return price + utilityRent(7, count) * 2;
  }
  const { others, owned, completes, blocks } = groupInfo(snap, playerId, tileIndex);
  let value = price + rentLevels(price)[0] * VALUE.rentTurns;
  if (others.length > 0) value += price * VALUE.progress * (owned / others.length);
  if (completes) value += price * (VALUE.completion + (snap.rules.doubleRentSets ? VALUE.completionDouble : 0));
  if (blocks) value += price * VALUE.block;
  return Math.round(value);
}

/** Does the player own every tile of some country (a complete set)? */
export function ownsFullSet(snap: GameSnapshot, playerId: string): boolean {
  return Object.values(GROUPS).some((g) => g.every((i) => snap.properties[i]?.ownerId === playerId));
}

/** Net worth used when the game ends with only bots left: cash plus half the price of every owned tile. */
export function netWorth(snap: GameSnapshot, playerId: string): number {
  const cash = snap.players.find((p) => p.id === playerId)?.cash ?? 0;
  const tiles = Object.entries(snap.properties).filter(([, v]) => v.ownerId === playerId).reduce((sum, [k]) => sum + Math.floor((tileAt(Number(k)).price ?? 0) / 2), 0);
  return cash + tiles;
}
