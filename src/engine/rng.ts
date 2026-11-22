// Seeded RNG (mulberry32). The state is a single uint32 so the engine stays a pure function of its state.
export function mulberry32(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
}

/** Small mutable wrapper used inside one engine step; read `.state` afterwards to store it back. */
export class Rng {
  constructor(public state: number) {}
  next(): number {
    const r = mulberry32(this.state);
    this.state = r.state;
    return r.value;
  }
  /** Integer in [0, max). */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** Turns any seed (number or string) into a uint32 start state. */
export function seedToState(seed: number | string): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
