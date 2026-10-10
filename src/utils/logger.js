// logger.js
// Mini logger zero-dependency (pengganti winston + winston-daily-rotate-file).
//
// Kenapa diganti: dependency tree winston + file I/O tiap baris log ke disk
// ephemeral itu keberatan buat free tier Wispbyte. Semua log sekarang ke
// stdout/stderr (kebaca dari log viewer Wispbyte).
//
// API tetap sama: logger.error/warn/info/debug(message, meta?),
// startupLog, shutdownLog, plus helper trace context di bawah.
// Level: error < warn < info < debug via LOG_LEVEL env (default: info di
// production, debug selain itu). Timestamp WIB. warn/error ke stderr.

import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Trace context (AsyncLocalStorage bawaan Node — tidak terkait winston)
// ---------------------------------------------------------------------------

const traceStorage = new AsyncLocalStorage();

function sanitizeCommandName(interaction) {
  if (interaction?.isChatInputCommand?.() && interaction.commandName) {
    return interaction.commandName;
  }

  if (interaction?.isButton?.() || interaction?.isModalSubmit?.() || interaction?.isStringSelectMenu?.()) {
    return interaction.customId || null;
  }

  return null;
}

export function createTraceId(prefix = 'trc') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function createInteractionTraceContext(interaction, overrides = {}) {
  return {
    traceId: createTraceId(),
    interactionId: interaction?.id || null,
    interactionType: interaction?.type || null,
    guildId: interaction?.guildId || null,
    channelId: interaction?.channelId || null,
    userId: interaction?.user?.id || null,
    command: sanitizeCommandName(interaction),
    ...overrides
  };
}

export function runWithTraceContext(traceContext, callback) {
  return traceStorage.run(traceContext, callback);
}

export function getTraceContext() {
  return traceStorage.getStore() || null;
}

export function getTraceId() {
  return getTraceContext()?.traceId || null;
}

// ---------------------------------------------------------------------------
// Level & format
// ---------------------------------------------------------------------------

const SERVICE = 'hios-bot';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const defaultLogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

const logLevelAliases = {
  warning: 'warn',
  warnings: 'warn',
  warns: 'warn',
  err: 'error',
  information: 'info',
};

const rawRequestedLogLevel = process.env.LOG_LEVEL?.toLowerCase().trim();
const requestedLogLevel = logLevelAliases[rawRequestedLogLevel] || rawRequestedLogLevel;

const resolvedLogLevel = LEVELS[requestedLogLevel] !== undefined
  ? requestedLogLevel
  : defaultLogLevel;

const shouldPromoteUserFacingLogs = process.env.NODE_ENV === 'production' && resolvedLogLevel === 'warn';

const WIB_OFFSET_MS = 7 * 3600 * 1000;

function timestamp() {
  return new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Skema log (dipertahankan dari logger winston lama)
// ---------------------------------------------------------------------------

const LOG_SCHEMA_DEFAULTS = Object.freeze({
  event: 'application.log',
  guildId: null,
  userId: null,
  command: null,
  errorCode: null,
  traceId: null,
});

function deriveErrorCode(meta) {
  if (meta.errorCode) {
    return meta.errorCode;
  }

  if (typeof meta.code === 'string' || typeof meta.code === 'number') {
    return String(meta.code);
  }

  if (typeof meta.type === 'string') {
    return meta.type;
  }

  const err = meta.error;
  if (err && (typeof err.code === 'string' || typeof err.code === 'number')) {
    return String(err.code);
  }

  return null;
}

function normalizeEvent(meta) {
  if (typeof meta.event === 'string' && meta.event.trim()) {
    return meta.event;
  }

  return `log.${meta._level || 'info'}`;
}

function attachTraceContext(meta) {
  const traceContext = getTraceContext();
  if (!traceContext) {
    return meta;
  }

  meta.traceId = meta.traceId || traceContext.traceId;
  meta.guildId = meta.guildId || traceContext.guildId;
  meta.userId = meta.userId || traceContext.userId;
  meta.command = meta.command || traceContext.command;
  meta.interactionId = meta.interactionId || traceContext.interactionId;

  return meta;
}

function buildDetails(meta, level) {
  meta._level = level;
  attachTraceContext(meta);
  const eventExplicit = typeof meta.event === 'string' && meta.event.trim();
  const details = {
    event: eventExplicit ? meta.event.trim() : normalizeEvent(meta),
    guildId: meta.guildId ?? LOG_SCHEMA_DEFAULTS.guildId,
    userId: meta.userId ?? LOG_SCHEMA_DEFAULTS.userId,
    command: meta.command ?? LOG_SCHEMA_DEFAULTS.command,
    errorCode: deriveErrorCode(meta),
    traceId: meta.traceId ?? LOG_SCHEMA_DEFAULTS.traceId,
  };
  if (meta.interactionId) {
    details.interactionId = meta.interactionId;
  }
  // Field meta lain yang tidak dikenal tetap ikut, biar tidak ada info hilang.
  for (const [key, value] of Object.entries(meta)) {
    if (key === '_level' || key in details) {
      continue;
    }
    details[key] = value;
  }
  // Buang yang null supaya baris log ringkas.
  for (const key of Object.keys(details)) {
    if (details[key] === null || details[key] === undefined) {
      delete details[key];
    }
  }
  // Event auto-generated tanpa info lain = noise, buang.
  if (!eventExplicit && Object.keys(details).length === 1 && details.event) {
    delete details.event;
  }
  return details;
}

function stringifyDetails(details) {
  if (Object.keys(details).length === 0) {
    return '';
  }
  const json = JSON.stringify(details, (_key, value) =>
    value instanceof Error ? { message: value.message, stack: value.stack } : value
  );
  return ` ${json}`;
}

function write(level, displayLevel, message, meta, extraArgs) {
  if (LEVELS[level] > LEVELS[resolvedLogLevel]) {
    return;
  }
  const label = displayLevel || level.toUpperCase();
  const prefix = `[${timestamp()}] [${SERVICE}] [${label}]`;
  const details = stringifyDetails(buildDetails(meta, level));
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(`${prefix} ${message}${details}`, ...extraArgs);
}

function make(level) {
  return (message, metaOrError, ...rest) => {
    let meta = {};
    const extraArgs = [];
    if (metaOrError instanceof Error) {
      // logger.error('msg', err) — cetak stack seperti errors({stack:true}) dulu.
      extraArgs.push(metaOrError.stack || metaOrError.message);
      meta = { errorCode: deriveErrorCode({ error: metaOrError }) };
    } else if (metaOrError && typeof metaOrError === 'object') {
      meta = { ...metaOrError };
    } else if (metaOrError !== undefined) {
      extraArgs.push(metaOrError);
    }
    write(level, null, message, meta, [...extraArgs, ...rest]);
  };
}

const logger = {
  error: make('error'),
  warn: make('warn'),
  info: make('info'),
  debug: make('debug'),
  level: resolvedLogLevel,
};

// logger.stream (morgan) sudah tidak dipakai di mana pun — dibuang.

// ---------------------------------------------------------------------------
// Startup / status log (dipakai di app.js & events/ready.js)
// ---------------------------------------------------------------------------

function startupLog(message) {
  const level = shouldPromoteUserFacingLogs ? 'warn' : 'info';
  if (LEVELS[level] > LEVELS[resolvedLogLevel]) {
    return;
  }
  const out = level === 'warn' ? console.error : console.log;
  out(`[${timestamp()}] [${SERVICE}] [STARTUP] ${message}`);
}

function shutdownLog(message) {
  const level = shouldPromoteUserFacingLogs ? 'warn' : 'info';
  if (LEVELS[level] > LEVELS[resolvedLogLevel]) {
    return;
  }
  const out = level === 'warn' ? console.error : console.log;
  out(`[${timestamp()}] [${SERVICE}] [STATUS] ${message}`);
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

if (rawRequestedLogLevel && !hasOwn(logLevelAliases, rawRequestedLogLevel) && !hasOwn(LEVELS, rawRequestedLogLevel)) {
  // Selalu tampil walau level diset ke error.
  console.error(
    `[${timestamp()}] [${SERVICE}] [WARN] Invalid LOG_LEVEL "${process.env.LOG_LEVEL}". Falling back to "${defaultLogLevel}".`
  );
}

export { logger, startupLog, shutdownLog };

export default logger;
