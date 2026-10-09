// xpSystem.js

import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData, normalizeRewardRoles } from './leveling.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { Mutex } from '../../utils/mutex.js';
import { wrapServiceBoundary } from '../../utils/errorHandler.js';

/**
 * Award XP to a member. Returns null when XP is skipped (disabled/invalid amount).
 * Throws on storage or unexpected failures.
 */
export const addXp = wrapServiceBoundary(async function addXp(client, guild, member, xpToAdd) {
  const lockKey = `leveling:${guild.id}:${member.user.id}`;
  return await Mutex.runExclusive(lockKey, async () => {
    if (!xpToAdd || xpToAdd <= 0) {
      return null;
    }

    const config = await getLevelingConfig(client, guild.id);

    if (!config.enabled) {
      return null;
    }

    const levelData = await getUserLevelData(client, guild.id, member.user.id);

    levelData.xp += xpToAdd;
    levelData.totalXp += xpToAdd;
    levelData.lastMessage = Date.now();

    let xpNeededForNextLevel = getXpForLevel(levelData.level);
    let didLevelUp = false;
    const initialLevel = levelData.level;

    while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
      levelData.xp -= xpNeededForNextLevel;
      levelData.level += 1;
      didLevelUp = true;
      xpNeededForNextLevel = getXpForLevel(levelData.level);

      logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

      if (config.roleRewards && config.roleRewards[levelData.level]) {
        for (const roleId of normalizeRewardRoles(config.roleRewards[levelData.level])) {
          await awardRoleReward(guild, member, roleId, levelData.level);
        }
      }
    }

    if (didLevelUp) {
      if (config.announceLevelUp) {
        await sendLevelUpAnnouncement(guild, member, levelData, config, initialLevel);
      }

      try {
        await logEvent({
          client,
          guildId: guild.id,
          eventType: EVENT_TYPES.LEVELING_LEVELUP,
          data: {
            title: 'Level Up',
            lines: [
              formatLogLine('Member', `${member.user.tag} (\`${member.user.id}\`)`),
              formatLogLine('New Level', levelData.level.toString()),
              formatLogLine('Levels Gained', (levelData.level - initialLevel).toString()),
              formatLogLine('Total XP', levelData.totalXp.toString()),
            ],
            userId: member.user.id,
          },
        });
      } catch (logError) {
        logger.debug('Failed to log leveling event:', logError.message);
      }
    }

    await saveUserLevelData(client, guild.id, member.user.id, levelData);

    return {
      level: levelData.level,
      xp: levelData.xp,
      totalXp: levelData.totalXp,
      xpNeeded: getXpForLevel(levelData.level + 1),
      leveledUp: didLevelUp,
    };
  });
}, {
  service: 'xpSystem',
  operation: 'addXp',
  userMessage: 'Failed to award XP. Please try again.',
});

async function awardRoleReward(guild, member, roleId, level) {
  try {
    const role = guild.roles.cache.get(roleId);

    if (!role) {
      logger.warn(`Role ${roleId} not found for level ${level} reward in guild ${guild.id}`);
      return;
    }

    if (member.roles.cache.has(roleId)) {
      return;
    }

    await member.roles.add(role, `Level ${level} reward`);
    logger.info(`✅ Awarded role ${role.name} to ${member.user.tag} for reaching level ${level}`);
  } catch (error) {
    logger.error(`Failed to award role reward to ${member.user.id}:`, error);
  }
}

/**
 * Send a sample level-up embed so admins can preview the announcement
 * without waiting for a real level-up. Uses the caller's own member data
 * (avatar, mention) with their current level -> level + 1.
 */
export const sendLevelUpPreview = wrapServiceBoundary(async function sendLevelUpPreview(client, guild, member) {
  const config = await getLevelingConfig(client, guild.id);
  const levelData = await getUserLevelData(client, guild.id, member.user.id);
  const previewData = { ...levelData, level: levelData.level + 1 };
  await sendLevelUpAnnouncement(guild, member, previewData, config, levelData.level);
}, {
  service: 'xpSystem',
  operation: 'sendLevelUpPreview',
  userMessage: 'Failed to send level-up preview.',
});

const DEFAULT_LEVELUP_COLOR = '#FFC107';

/**
 * Validate a hex color string. Falls back to the default gold on invalid input.
 */
function resolveLevelUpColor(raw) {
  if (typeof raw === 'string') {
    const normalized = raw.startsWith('#') ? raw : `#${raw}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(normalized)) {
      return normalized.toUpperCase();
    }
  }
  return DEFAULT_LEVELUP_COLOR;
}

async function sendLevelUpAnnouncement(guild, member, levelData, config, initialLevel) {
  try {
    const levelUpChannel = config.levelUpChannel
      ? guild.channels.cache.get(config.levelUpChannel)
      : guild.systemChannel;

    if (!levelUpChannel || !levelUpChannel.isTextBased()) {
      return;
    }

    const permissions = levelUpChannel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions to send levelup message in ${levelUpChannel.id}`);
      return;
    }

    const oldLevel = Number.isInteger(initialLevel) ? initialLevel : levelData.level;
    const newLevel = levelData.level;

    const description = config.levelUpMessage
      .replace(/{user}/g, member.toString())
      .replace(/{level}/g, newLevel)
      .replace(/{xp}/g, levelData.xp)
      .replace(/{xpNeeded}/g, getXpForLevel(newLevel + 1));

    const embed = new EmbedBuilder()
      .setColor(resolveLevelUpColor(config.levelUpColor))
      .setTitle('🎉 Level Up!')
      .setDescription(description)
      .setThumbnail(member.displayAvatarURL({ size: 256 }))
      .setFooter({ text: `Level ${oldLevel} → ${newLevel}` })
      .setTimestamp();

    await levelUpChannel.send({ embeds: [embed] }).catch(error => {
      logger.error(`Failed to send level up message in channel ${levelUpChannel.id}:`, error);
    });
  } catch (error) {
    logger.error('Error sending level up announcement:', error);
  }
}
