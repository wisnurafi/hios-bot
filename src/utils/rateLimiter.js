// rateLimiter.js

import { logger } from './logger.js';

const rateLimitStore = new Map();

// Bound the store: without a cap + prune, keys accumulate forever
// (one per xp-event:<guild>:<user> on every message). Mirrors the
// verificationService.js pattern.
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 300_000;
let lastPruneAt = 0;

function pruneExpiredRateLimits(now = Date.now()) {
  if (now - lastPruneAt < RATE_LIMIT_PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneAt = now;

  for (const [key, entry] of rateLimitStore.entries()) {
    const windowMs = entry?.windowMs || 60_000;
    if (now - entry.windowStart > windowMs) {
      rateLimitStore.delete(key);
    }
  }
}

function enforceRateLimitCap() {
  // Map preserves insertion order: evict oldest first. Runs unthrottled —
  // cheap and guarantees the bound even under burst traffic.
  while (rateLimitStore.size > MAX_RATE_LIMIT_ENTRIES) {
    const firstKey = rateLimitStore.keys().next().value;
    if (!firstKey) {
      break;
    }
    rateLimitStore.delete(firstKey);
  }
}

export async function checkRateLimit(key, maxAttempts = 5, windowMs = 60000) {
  try {
    pruneExpiredRateLimits();
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now - entry.windowStart > windowMs) {
      rateLimitStore.set(key, {
        count: 1,
        windowStart: now,
        windowMs
      });
      enforceRateLimitCap();
      return true;
    }

    if (entry.count < maxAttempts) {
      entry.count++;
      return true;
    }

    logger.debug(`Rate limit exceeded for ${key}`);
    return false;
  } catch (error) {
    logger.error('Error checking rate limit:', error);
    return true; 
  }
}

export function getRateLimitStatus(key, windowMs = 60000) {
  const entry = rateLimitStore.get(key);
  if (!entry) {
    return { limited: false, remaining: windowMs };
  }

  const elapsed = Date.now() - entry.windowStart;
  const remaining = Math.max(0, windowMs - elapsed);

  return {
    limited: remaining > 0,
    remaining,
    attempts: entry.count
  };
}

export function clearRateLimit(key) {
  rateLimitStore.delete(key);
}

export function clearAllRateLimits() {
  rateLimitStore.clear();
  logger.info('All rate limits cleared');
}