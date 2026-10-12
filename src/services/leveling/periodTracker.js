// periodTracker.js — biweekly XP tracking for the scheduled leaderboard.
//
// Each XP grant also bumps a per-user counter for the *current* period:
//   guild:<id>:leveling:period:<periodId>:<userId> -> xp
// Periods rotate every 14 days when the scheduled leaderboard is posted; the
// old period's keys are deleted so storage never grows. All operations are
// best-effort — tracking must never break the normal XP flow.
//
// Storage: temp_data KV (parsed as type 'temp' in keyParser.js) with a 15-day
// TTL — keys self-clean even if the scheduler is disabled mid-period and
// clearPeriod never runs.

import { logger } from '../../utils/logger.js';
import { getPeriodXpKey, getPeriodXpPrefix } from '../../utils/database/keys.js';

// 15 days > 14-day period: a key expires only after its period is long over,
// even if rotation never happens.
const PERIOD_XP_TTL_SECONDS = 15 * 24 * 3600;

/**
 * Add XP to a user's current-period counter. Uses atomic increment —
 * no read-modify-write needed. TTL refreshes on every grant.
 */
export async function addPeriodXp(client, guildId, userId, periodId, amount) {
    if (!client?.db || !guildId || !userId || !periodId || !amount || amount <= 0) return;
    try {
        await client.db.increment(getPeriodXpKey(guildId, periodId, userId), amount, PERIOD_XP_TTL_SECONDS);
    } catch (error) {
        logger.warn(`Period XP track failed for ${userId} in guild ${guildId}: ${error.message}`);
    }
}

/**
 * Top XP earners of a period, sorted desc. Returns [{ userId, xp }].
 * Single indexed query on PostgreSQL (no N+1).
 */
export async function getPeriodTop(client, guildId, periodId, limit = 15) {
    if (!client?.db || !guildId || !periodId) return [];
    const prefix = getPeriodXpPrefix(guildId, periodId);

    let rows = [];
    try {
        rows = (await client.db.getTopByPrefix(prefix, limit)) || [];
    } catch (error) {
        logger.warn(`Period XP top failed in guild ${guildId}: ${error.message}`);
        return [];
    }

    const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 15, 1), 100);
    return rows.slice(0, safeLimit).map(({ key, value }) => {
        const userId = key.slice(prefix.length);
        return { userId, xp: value };
    }).filter((entry) => entry.userId && !entry.userId.includes(':') && entry.xp > 0);
}

/**
 * Delete every key of a finished period in one query.
 * Storage stays flat forever.
 */
export async function clearPeriod(client, guildId, periodId) {
    if (!client?.db || !guildId || !periodId) return;
    const prefix = getPeriodXpPrefix(guildId, periodId);
    try {
        const deleted = await client.db.deleteByPrefix(prefix);
        logger.info(`Cleared ${deleted} period-XP key(s) for period ${periodId} in guild ${guildId}`);
    } catch (error) {
        logger.warn(`Period XP clear failed in guild ${guildId}: ${error.message}`);
    }
}
