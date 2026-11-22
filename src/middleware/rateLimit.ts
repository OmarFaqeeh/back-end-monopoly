// REST rate limits. Every limit answers 429 with the stable error shape { error: "RATE_LIMITED" }.
import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";

const base = {
  windowMs: 60_000,
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  handler: ((_req, res) => {
    res.status(429).json({ error: "RATE_LIMITED" });
  }) satisfies RequestHandler,
};

/** GET /api/rooms/:code: 30 requests per minute per IP. */
export const lookupLimiter = (limit = 30) => rateLimit({ ...base, limit });

/** At most 10 FAILED lookups (status >= 400) per minute per IP; successful lookups do not count. */
export const failedLookupLimiter = (limit = 10) => rateLimit({ ...base, limit, skipSuccessfulRequests: true });

/** POST /api/rooms: 10 creations per minute per IP. */
export const createLimiter = (limit = 10) => rateLimit({ ...base, limit });
