import { pgDb } from '../postgresDatabase.js';
import { MemoryStorage } from '../memoryStorage.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';

// How often to retry PostgreSQL while running in degraded (in-memory) mode.
// Mirrors hios-ronda's reconnect loop; cheap and self-stopping on success.
const RECONNECT_INTERVAL_MS = 5 * 60 * 1000;

class DatabaseWrapper {
    constructor() {
        this.initialized = false;
        this.db = null;
        this.useFallback = false;
        this.connectionType = 'none';
        this.degradedModeWarningShown = false;
        this.degradedReason = null;
        this.reconnectTimer = null;
        this.reconnecting = false;
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            logger.info('Attempting to connect to PostgreSQL...');
            const pgConnected = await pgDb.connect();
            if (pgConnected) {
                this.db = pgDb;
                this.connectionType = 'postgresql';
                this.degradedReason = null;
                logger.info('✅ PostgreSQL Database initialized - using persistent database');
                this.initialized = true;
                return;
            }

            const pgFailure = pgDb.getLastFailure?.();
            if (pgFailure?.reason === 'SCHEMA_VERSION_MISMATCH') {
                const schemaError = new Error(
                    `Schema version mismatch detected (${pgFailure.message}). Run migrations before startup.`,
                );
                schemaError.code = 'SCHEMA_VERSION_MISMATCH';
                throw schemaError;
            }
        } catch (error) {
            logger.warn('PostgreSQL connection failed:', error.message);

            if (error.code === 'SCHEMA_VERSION_MISMATCH') {
                throw error;
            }
        }

        this.db = new MemoryStorage();
        this.useFallback = true;
        this.connectionType = 'memory';
        this.degradedReason = 'POSTGRES_UNAVAILABLE';
        logger.warn('⚠️ DATABASE DEGRADED MODE ENABLED - Using in-memory storage (data will be lost on restart)');
        logger.warn('⚠️ Please check PostgreSQL connection and restart the bot when fixed');
        this.initialized = true;
        this.degradedModeWarningShown = true;
        // Neon free tier suspends compute when idle — the DB may just be
        // waking up. Keep retrying in the background instead of staying
        // degraded until a manual restart.
        this.startReconnectLoop();
    }

    startReconnectLoop() {
        if (this.reconnectTimer) {
            return;
        }
        logger.info('Starting PostgreSQL reconnect loop (every 5 minutes)...');
        this.reconnectTimer = setInterval(() => {
            this.attemptReconnect().catch((error) => {
                logger.warn('PostgreSQL reconnect attempt failed:', error.message);
            });
        }, RECONNECT_INTERVAL_MS);
        if (typeof this.reconnectTimer.unref === 'function') {
            this.reconnectTimer.unref();
        }
    }

    stopReconnectLoop() {
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    async attemptReconnect() {
        if (!this.useFallback || this.reconnecting) {
            return;
        }
        this.reconnecting = true;
        try {
            logger.info('Attempting PostgreSQL reconnect...');
            // Drop the cached failed attempt so pgDb makes a fresh one.
            pgDb.connectionPromise = null;
            const connected = await pgDb.connect();
            if (!connected) {
                logger.warn('PostgreSQL reconnect failed — will retry in 5 minutes.');
                return;
            }
            await this.flushMemoryToPostgres();
            this.db = pgDb;
            this.useFallback = false;
            this.connectionType = 'postgresql';
            this.degradedReason = null;
            this.stopReconnectLoop();
            logger.info('✅ PostgreSQL reconnected — recovered from degraded mode');
        } finally {
            this.reconnecting = false;
        }
    }

    // Best-effort: copy everything written to memory while degraded into
    // PostgreSQL before swapping backends. PostgreSQL received no writes
    // during degraded mode (single process), so memory holds the newest
    // state. TTLs are not preserved and expired keys are already skipped by
    // MemoryStorage.list. Per-key failures are logged, never fatal.
    async flushMemoryToPostgres() {
        const memory = this.db;
        if (!memory || typeof memory.list !== 'function') {
            return;
        }
        let keys = [];
        try {
            keys = await memory.list('');
        } catch (error) {
            logger.warn('Could not list memory keys for flush:', error.message);
            return;
        }
        let ok = 0;
        for (const key of keys) {
            try {
                const value = await memory.get(key);
                if (value === null || value === undefined) {
                    continue;
                }
                await pgDb.set(key, value);
                ok += 1;
            } catch (error) {
                logger.warn(`Failed to flush memory key ${key} to PostgreSQL:`, error.message);
            }
        }
        logger.info(`Flushed ${ok}/${keys.length} memory keys to PostgreSQL`);
    }

    async set(key, value, ttl = null) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Writing to memory: ${key}`);
        }

        if (typeof key === 'string' && /^guild:[^:]+:config$/.test(key)) {
            const guildId = key.split(':')[1];
            validateGuildConfigOrThrow(value, {
                guildId,
                errorCode: 'VALIDATION_FAILED',
            });
        }

        return this.db.set(key, value, ttl);
    }

    async get(key, defaultValue = null) {
        return this.db.get(key, defaultValue);
    }

    async delete(key) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Deleting from memory: ${key}`);
        }
        return this.db.delete(key);
    }

    async list(prefix) {
        return this.db.list(prefix);
    }

    async exists(key) {
        if (this.db.exists) {
            return this.db.exists(key);
        }
        const value = await this.db.get(key);
        return value !== null;
    }

    async increment(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Incrementing in memory: ${key}`);
        }
        if (this.db.increment) {
            return this.db.increment(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current + amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    async decrement(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Decrementing in memory: ${key}`);
        }
        if (this.db.decrement) {
            return this.db.decrement(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current - amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    isDegraded() {
        return this.useFallback;
    }

    isAvailable() {
        return this.db && !this.useFallback;
    }

    getStatus() {
        return {
            initialized: this.initialized,
            connectionType: this.connectionType,
            isDegraded: this.useFallback,
            isAvailable: this.isAvailable(),
            degradedReason: this.degradedReason,
        };
    }

    getConnectionType() {
        return this.connectionType;
    }
}

export const db = new DatabaseWrapper();

export async function initializeDatabase() {
    try {
        logger.info('Initializing Database (PostgreSQL > Memory fallback)...');
        await db.initialize();
        logger.info('✅ Database initialized');
        return { db };
    } catch (error) {
        logger.error('❌ Database Initialization Error:', error);

        if (error.code === 'SCHEMA_VERSION_MISMATCH') {
            throw error;
        }

        return { db };
    }
}

export async function getFromDb(key, defaultValue = null) {
    try {
        const value = await db.get(key);
        return value === null ? defaultValue : value;
    } catch (error) {
        logger.error(`Error getting value for key ${key}:`, error);
        return defaultValue;
    }
}

export async function setInDb(key, value, ttl = null) {
    try {
        await db.set(key, value, ttl);
        return true;
    } catch (error) {
        logger.error(`Error setting value for key ${key}:`, error);
        return false;
    }
}

export async function deleteFromDb(key) {
    try {
        await db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting key ${key}:`, error);
        return false;
    }
}
