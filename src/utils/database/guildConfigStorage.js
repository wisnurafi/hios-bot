import { logger } from '../logger.js';
import { GUILD_CONFIG_DEFAULTS } from '../../config/guild/guildConfigDefaults.js';
import { normalizeGuildConfig, validateGuildConfigOrThrow } from '../schemas.js';
import { createError, ErrorTypes } from '../errorHandler.js';
import { getGuildConfigKey } from './keys.js';

/**
 * In-memory guild config cache. Guild config is read on hot paths
 * (every message for leveling, every voiceStateUpdate, every logEvent)
 * but changes rarely, so a short TTL cache removes 4-5 sequential DB
 * round trips per message. Invalidated on every write below.
 */
const GUILD_CONFIG_CACHE_TTL_MS = 45_000;
const GUILD_CONFIG_CACHE_MAX = 1000;
const guildConfigCache = new Map(); // guildId -> { config, expiresAt }

function getCachedGuildConfig(guildId) {
    const entry = guildConfigCache.get(guildId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        guildConfigCache.delete(guildId);
        return null;
    }
    // structuredClone: callers must never mutate the cached object.
    return structuredClone(entry.config);
}

function setCachedGuildConfig(guildId, config) {
    if (guildConfigCache.size >= GUILD_CONFIG_CACHE_MAX) {
        // Evict oldest (Map preserves insertion order).
        const oldest = guildConfigCache.keys().next();
        if (!oldest.done) guildConfigCache.delete(oldest.value);
    }
    guildConfigCache.set(guildId, {
        config: structuredClone(config),
        expiresAt: Date.now() + GUILD_CONFIG_CACHE_TTL_MS,
    });
}

function invalidateGuildConfigCache(guildId) {
    guildConfigCache.delete(guildId);
}

export function unwrapReplitData(data) {
    if (
        typeof data === 'object' &&
        data !== null &&
        data.ok !== undefined &&
        data.value !== undefined
    ) {
        return unwrapReplitData(data.value);
    }
    return data;
}

/**
 * Low-level guild config read. Returns normalized config with defaults;
 * never throws — callers use the guild config service for typed errors.
 */
export async function readGuildConfig(client, guildId, context = {}) {
    try {
        if (!client?.db || typeof client.db.get !== 'function') {
            logger.warn(`Database unavailable for readGuildConfig in guild ${guildId}`);
            return normalizeGuildConfig({}, GUILD_CONFIG_DEFAULTS);
        }

        if (typeof client.db.isAvailable === 'function' && !client.db.isAvailable()) {
            logger.warn(`PostgreSQL unavailable for readGuildConfig in guild ${guildId}`, {
                traceId: context.traceId,
                guildId,
            });
            return normalizeGuildConfig({}, GUILD_CONFIG_DEFAULTS);
        }

        const cached = getCachedGuildConfig(guildId);
        if (cached) {
            return cached;
        }

        const rawConfig = await client.db.get(getGuildConfigKey(guildId), null);

        if (rawConfig === null) {
            const defaults = normalizeGuildConfig({}, GUILD_CONFIG_DEFAULTS);
            setCachedGuildConfig(guildId, defaults);
            return structuredClone(defaults);
        }

        const cleanedConfig = unwrapReplitData(rawConfig);
        const normalized = normalizeGuildConfig(cleanedConfig, GUILD_CONFIG_DEFAULTS);
        setCachedGuildConfig(guildId, normalized);
        return structuredClone(normalized);
    } catch (error) {
        logger.error(`Error fetching config for guild ${guildId}`, {
            error,
            traceId: context.traceId,
            guildId,
            userId: context.userId,
            command: context.command,
        });
        return normalizeGuildConfig({}, GUILD_CONFIG_DEFAULTS);
    }
}

/**
 * Low-level guild config write. Validates payload and throws on failure.
 */
export async function writeGuildConfig(client, guildId, config, context = {}) {
    if (!client?.db || typeof client.db.set !== 'function') {
        throw createError(
            'Database client unavailable for guild config write',
            ErrorTypes.DATABASE,
            'Failed to save server configuration. The database is unavailable.',
            { guildId, ...context },
        );
    }

    const validated = validateGuildConfigOrThrow(config, { guildId, ...context });
    const saved = await client.db.set(getGuildConfigKey(guildId), validated);

    if (!saved) {
        throw createError(
            'Guild config write rejected by database layer',
            ErrorTypes.DATABASE,
            'Failed to save server configuration. Please try again.',
            { guildId, ...context },
        );
    }

    invalidateGuildConfigCache(guildId);

    return validated;
}
