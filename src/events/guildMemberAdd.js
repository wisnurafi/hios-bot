import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { botConfig } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage, getDefaultGettingStartedMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Bundled fallback banner (assets/welcome-banner.png). An admin-configured
// welcomeImage URL always takes priority over this file.
const WELCOME_BANNER_PATH = join(__dirname, '..', '..', 'assets', 'welcome-banner.png');
const WELCOME_BANNER_NAME = 'welcome-banner.png';

export default {
  name: Events.GuildMemberAdd,
  once: false,
  
  async execute(member) {
    try {
        const { guild, user } = member;
        
        const config = await getGuildConfig(member.client, guild.id);
        
        const welcomeConfig = await getWelcomeConfig(member.client, guild.id);
        
        const welcomeChannelId = welcomeConfig?.channelId;

        if (welcomeConfig?.enabled && welcomeChannelId) {
            const channel = guild.channels.cache.get(welcomeChannelId);
            const me = guild.members.me;
            const permissions = channel?.isTextBased?.() && me ? channel.permissionsFor(me) : null;
            // Skip only the welcome message if permissions are missing; the rest of the
            // join pipeline (auto-role, verification, logging, counters) must still run.
            if (permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                const formatData = { user, guild, member };
                const welcomeMessage = formatWelcomeMessage(
                    welcomeConfig.welcomeMessage || welcomeConfig.welcomeEmbed?.description || botConfig.welcome?.defaultWelcomeMessage || 'Welcome {user} to {server}!',
                    formatData
                );

                const messageContent = welcomeConfig.welcomePing ? user.toString() : null;

                const canEmbed = permissions.has(PermissionFlagsBits.EmbedLinks);

                if (!canEmbed) {
                    await channel.send({
                        content: messageContent || welcomeMessage
                    });
                } else {
                    // Banner-style layout (reference: multi-embed welcome card):
                    //   1. banner image embed
                    //   2. "👋 Welcome" embed with the new member's avatar
                    //   3. "✅ Getting Started" embed with the server icon
                    const embeds = [];
                    const files = [];

                    const bannerUrl = welcomeConfig.welcomeImage || welcomeConfig.welcomeEmbed?.image?.url || null;
                    if (bannerUrl) {
                        embeds.push(new EmbedBuilder().setImage(bannerUrl));
                    } else if (existsSync(WELCOME_BANNER_PATH)) {
                        files.push({ attachment: WELCOME_BANNER_PATH, name: WELCOME_BANNER_NAME });
                        embeds.push(new EmbedBuilder().setImage(`attachment://${WELCOME_BANNER_NAME}`));
                    }

                    embeds.push(
                        new EmbedBuilder()
                            .setTitle('👋 Welcome')
                            .setDescription(welcomeMessage)
                            .setThumbnail(user.displayAvatarURL())
                    );

                    const gettingStartedTemplate = welcomeConfig.welcomeGettingStarted || getDefaultGettingStartedMessage();
                    const gettingStartedResolved = gettingStartedTemplate
                        .split('{rules}').join(welcomeConfig.welcomeRulesChannelId ? `<#${welcomeConfig.welcomeRulesChannelId}>` : 'the rules channel')
                        .split('{verify}').join(welcomeConfig.welcomeVerifyChannelId ? `<#${welcomeConfig.welcomeVerifyChannelId}>` : 'the verification channel');
                    const gettingStartedText = formatWelcomeMessage(
                        `✅ **Getting Started**\n${gettingStartedResolved}\n\nThank you for joining and have a great time in **${guild.name}**!`,
                        formatData
                    );

                    const gettingStartedEmbed = new EmbedBuilder().setDescription(gettingStartedText);
                    const guildIcon = guild.iconURL();
                    if (guildIcon) {
                        gettingStartedEmbed.setThumbnail(guildIcon);
                    }
                    embeds.push(gettingStartedEmbed);

                    await channel.send({
                        content: messageContent,
                        embeds,
                        files
                    });
                }
            }
        }
        
        if (welcomeConfig?.roleIds && welcomeConfig.roleIds.length > 0) {
            const delay = welcomeConfig.autoRoleDelay || 0;
            const singleRoleId = welcomeConfig.roleIds[0];
            
            if (delay > 0) {
                const timeout = setTimeout(async () => {
                    const role = guild.roles.cache.get(singleRoleId);
                    if (role) {
                        await assignRoleSafely(member, role);
                    }
                }, delay * 1000);
                if (typeof timeout.unref === 'function') {
                    timeout.unref();
                }
            } else {
                const role = guild.roles.cache.get(singleRoleId);
                if (role) {
                    await assignRoleSafely(member, role);
                }
            }
        }
        
        if (config?.verification?.enabled || config?.verification?.autoVerify?.enabled) {
            await handleVerification(member, guild, config.verification, member.client);
        }

        try {
            await logEvent({
                client: member.client,
                guildId: guild.id,
                eventType: EVENT_TYPES.MEMBER_JOIN,
                data: {
                    title: 'User joined',
                    lines: [
                        `**User:** ${user.toString()} (${user.displayName !== user.username ? `@${user.displayName}` : user.tag})`,
                        `**ID:** \`${user.id}\``,
                        `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
                        `**Members:** ${guild.memberCount}`,
                    ],
                    quoted: false,
                    thumbnail: user.displayAvatarURL({ dynamic: true }),
                    userId: user.id,
                }
            });
        } catch (error) {
            logger.debug('Error logging member join:', error);
        }

        try {
            const counters = await getServerCounters(member.client, guild.id);
            for (const counter of counters) {
                if (counter && counter.type && counter.channelId && counter.enabled !== false) {
                    await updateCounter(member.client, guild, counter);
                }
            }
        } catch (error) {
            logger.debug('Error updating counters on member join:', error);
        }

    } catch (error) {
        logger.error('Error in guildMemberAdd event:', error);
    }
  }
};

async function handleVerification(member, guild, verificationConfig, client) {
    const { autoVerifyOnJoin } = await import('../services/verificationService.js');
    
    try {
        const result = await autoVerifyOnJoin(client, guild, member, verificationConfig);
        
        if (result.autoVerified) {
            logger.info('User auto-verified on join', {
                guildId: guild.id,
                userId: member.id,
                userTag: member.user.tag,
                roleName: result.roleName,
                criteria: result.criteria
            });
        } else {
            logger.debug('User not auto-verified on join', {
                guildId: guild.id,
                userId: member.id,
                reason: result.reason
            });
        }

    } catch (error) {
        logger.error('Error in auto-verification for member', {
            guildId: guild.id,
            userId: member.id,
            userTag: member.user.tag,
            error: error.message
        });
    }
}

async function assignRoleSafely(member, role) {
    try {
        await member.roles.add(role);
    } catch (error) {
        logger.warn(`Failed to assign role ${role.id} to member ${member.id}:`, error);
    }
}