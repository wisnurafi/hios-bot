/**
 * Control lockdown: restrict WHERE (channels) and BY WHOM (users) slash
 * commands can be invoked, with per-command exceptions.
 *
 * Empty lists = no restriction (default, backward compatible).
 * Enforcement lives in interactionCreate.js (slash commands only — component
 * interactions on public panels are intentionally untouched).
 */
import { getFromDb, setInDb } from './database/wrapper.js';
import { getControlLockdownKey } from './database/keys.js';

export function normalizeLockdown(raw) {
  const asIdList = (v) =>
    Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : [];
  return {
    channels: asIdList(raw?.channels),
    users: asIdList(raw?.users),
    except: asIdList(raw?.except),
  };
}

export async function loadControlLockdown(guildId) {
  const raw = await getFromDb(getControlLockdownKey(guildId), null);
  return normalizeLockdown(raw);
}

export async function saveControlLockdown(guildId, lockdown) {
  const normalized = normalizeLockdown(lockdown);
  await setInDb(getControlLockdownKey(guildId), normalized);
  return normalized;
}

/**
 * Returns null when the invocation is allowed, otherwise
 * `{ reason: 'channel' | 'user', message }` with a user-facing message.
 */
export function checkControlLockdown(
  lockdown,
  { commandName, userId, channelId, parentChannelId = null, isOwner = false },
) {
  const cfg = normalizeLockdown(lockdown);

  if (isOwner) {
    return null;
  }
  if (commandName && cfg.except.includes(commandName)) {
    return null;
  }

  if (cfg.channels.length > 0) {
    const inAllowedChannel =
      cfg.channels.includes(channelId) ||
      (parentChannelId != null && cfg.channels.includes(parentChannelId));
    if (!inAllowedChannel) {
      return {
        reason: 'channel',
        message: `This bot can only be controlled in ${cfg.channels.map((id) => `<#${id}>`).join(' ')}.`,
      };
    }
  }

  if (cfg.users.length > 0 && !cfg.users.includes(userId)) {
    return {
      reason: 'user',
      message: 'You are not on the list of people allowed to control this bot.',
    };
  }

  return null;
}
