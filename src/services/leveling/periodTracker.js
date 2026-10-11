// periodTracker.js — biweekly XP tracking for the scheduled leaderboard.
//
// Each XP grant also bumps a per-user counter for the *current* period:
//   guild:<id>:leveling:period:<periodId>:<userId> -> xp
// Periods rotate every 14 days when the scheduled leaderboard is posted; the
// old period's keys are deleted so storage never grows. All operations are
// best-effort — tracking must never break the normal XP flow.

import { logger } from '../../utils/logger.js';
import { getPeriodXpKey, getPeriodXpPrefix } from '../../utils/database/keys.js';

/**
 * Add XP to a user's current-period counter. Uses atomic increment —
 * no read-modify-write needed.
 */
export async function addPeriodXp(client, guildId, userId, periodId, amount) {
    if (!client?.db || !guildId || !userId || !periodId || !amount || amount <= 0) return;
    try {
        await client.db.increment(getPeriodXpKey(guildId, periodId, userId), amount);
    } catch (error) {
        logger.warn(`Period XP track failed for ${userId} in guild ${guildId}: ${error.message}`);
    }
}

/**
 * Top XP earners of a period, sorted desc. Returns [{ userId, xp }].
 */
export async function getPeriodTop(client, guildId, periodId, limit = 15) {
    if (!client?.db || !guildId || !periodId) return [];
    const prefix = getPeriodXpPrefix(guildId, periodId);

    let keys = [];
    try {
        keys = (await client.db.list(prefix)) || [];
    } catch (error) {
        logger.warn(`Period XP list failed in guild ${guildId}: ${error.message}`);
        return [];
    }

    const entries = [];
    for (const key of keys) {
        const userId = key.slice(prefix.length);
        if (!userId || userId.includes(':')) continue;
        let xp = 0;
        try {
            xp = Number(await client.db.get(key)) || 0;
        } catch {
            xp = 0;
        }
        if (xp > 0) entries.push({ userId, xp });
    }

    entries.sort((a, b) => b.xp - a.xp);
    return entries.slice(0, Math.max(1, limit));
}

/**
 * Delete every key of a finished period. Storage stays flat forever.
 */
export async function clearPeriod(client, guildId, periodId) {
    if (!client?.db || !guildId || !periodId) return;
    const prefix = getPeriodXpPrefix(guildId, periodId);
    let keys = [];
    try {
        keys = (await client.db.list(prefix)) || [];
    } catch (error) {
        logger.warn(`Period XP clear-list failed in guild ${guildId}: ${error.message}`);
        return;
    }
    for (const key of keys) {
        try {
            await client.db.delete(key);
        } catch {
            // best-effort; a stale key is harmless (periodId rotates anyway)
        }
    }
    logger.info(`Cleared ${keys.length} period-XP key(s) for period ${periodId} in guild ${guildId}`);
}
