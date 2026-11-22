// Typed, zod-validated environment. Fails fast with a clear message listing every problem.
import { z } from "zod";
import { DEFAULT_TIMINGS, type RoomTimings } from "./defaults.js";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** One or more allowed front-end origins, comma separated (for example https://dealrush-kappa.vercel.app). */
  FRONT_ORIGIN: z.string().min(1).default("http://localhost:3000"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be your Supabase Project URL").optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "SUPABASE_SERVICE_ROLE_KEY is missing").optional(),
  /** "1" keeps rooms in memory only (local tests and the browser run): no Supabase needed. */
  USE_IN_MEMORY_REPO: z.string().optional(),
  AFK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  TRUST_PROXY: z.string().optional(),
  ROOM_EMPTY_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

export interface Env {
  port: number;
  frontOrigin: string;
  /** Every origin allowed by CORS (FRONT_ORIGIN entries plus the deployed site). */
  frontOrigins: string[];
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  inMemory: boolean;
  trustProxy: boolean;
  timings: RoomTimings;
}

/** The deployed front end is always allowed, so a missing FRONT_ORIGIN on the host never blocks the site. */
export const DEPLOYED_ORIGINS = ["https://dealrush-kappa.vercel.app"];

export class EnvError extends Error {}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new EnvError(`Invalid environment (check back/.env):\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const origins = e.FRONT_ORIGIN.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  const badOrigin = origins.find((o) => !z.string().url().safeParse(o).success);
  if (badOrigin) throw new EnvError(`Invalid environment (check back/.env):\n  - FRONT_ORIGIN: "${badOrigin}" is not a URL such as http://localhost:3000`);
  const inMemory = e.USE_IN_MEMORY_REPO === "1";
  if (!inMemory && (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new EnvError("Invalid environment (check back/.env):\n  - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or set USE_IN_MEMORY_REPO=1 for local tests)");
  }
  return {
    port: e.PORT,
    frontOrigin: origins[0]!,
    frontOrigins: [...new Set([...origins, ...DEPLOYED_ORIGINS])],
    supabaseUrl: e.SUPABASE_URL ?? null,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY ?? null,
    inMemory,
    trustProxy: e.TRUST_PROXY === "1" || e.TRUST_PROXY === "true",
    timings: {
      ...DEFAULT_TIMINGS,
      emptyTimeoutMs: e.ROOM_EMPTY_TIMEOUT_MS ?? DEFAULT_TIMINGS.emptyTimeoutMs,
      afkTimeoutMs: e.AFK_TIMEOUT_MS ?? DEFAULT_TIMINGS.afkTimeoutMs,
    },
  };
}
