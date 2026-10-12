import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logModerationAction } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { HiosBotError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { randomBytes } from 'crypto';

import { InteractionHelper } from '../../utils/interactionHelper.js';

// Pending mass-ban confirmations: nonce -> { userIds, reason, deleteDays, guildId, ownerId, expiresAt }.
// Needed because up to 20 user IDs don't fit in a button customId.
const pendingMassBans = new Map();
const MASSBAN_CONFIRM_TTL_MS = 5 * 60_000;

function prunePendingMassBans(now = Date.now()) {
    for (const [nonce, pending] of pendingMassBans.entries()) {
        if (now > pending.expiresAt) {
            pendingMassBans.delete(nonce);
        }
    }
}

export function createPendingMassBan({ userIds, reason, deleteDays, guildId, ownerId }) {
    prunePendingMassBans();
    const nonce = randomBytes(8).toString('hex');
    pendingMassBans.set(nonce, {
        userIds,
        reason,
        deleteDays,
        guildId,
        ownerId,
        expiresAt: Date.now() + MASSBAN_CONFIRM_TTL_MS,
    });
    return nonce;
}

export function takePendingMassBan(nonce, ownerId) {
    const pending = pendingMassBans.get(nonce);
    if (!pending) {
        return null;
    }
    pendingMassBans.delete(nonce);
    if (Date.now() > pending.expiresAt || pending.ownerId !== ownerId) {
        return null;
    }
    return pending;
}

export async function executeMassBan({ client, guild, userIds, reason, deleteDays, executor }) {
    const results = {
        successful: [],
        failed: [],
        skipped: []
    };

    for (const userId of userIds) {
        try {
            const user = await client.users.fetch(userId).catch(() => null);

            if (!user) {
                results.failed.push({ userId, reason: "User not found" });
                continue;
            }

            const member = await guild.members.fetch(userId).catch(() => null);

            if (member) {
                const modCheck = ModerationService.validateHierarchy(executor, member, 'ban');
                if (!modCheck.valid) {
                    results.skipped.push({
                        user: user.tag,
                        userId,
                        reason: ModerationService.buildHierarchySkipReason(executor, member, 'ban'),
                    });
                    continue;
                }

                const botCheck = ModerationService.validateBotHierarchy(member, 'ban');
                if (!botCheck.valid) {
                    results.skipped.push({
                        user: user.tag,
                        userId,
                        reason: ModerationService.buildHierarchySkipReason(executor, member, 'ban', 'bot'),
                    });
                    continue;
                }
            }

            await guild.members.ban(userId, {
                reason: reason,
                deleteMessageSeconds: deleteDays * 24 * 60 * 60
            });

            results.successful.push({
                user: user.tag,
                userId
            });

            await logModerationAction({
                client,
                guild,
                event: {
                    action: "Member Banned",
                    target: `${user.tag} (${user.id})`,
                    executor: `${executor.tag} (${executor.id})`,
                    reason: `${reason} (Mass Ban)`,
                    metadata: {
                        userId: user.id,
                        moderatorId: executor.id,
                        massBan: true,
                        permanent: true
                    }
                }
            });

        } catch (error) {
            logger.error(`Failed to ban user ${userId}:`, error);
            const reason = error instanceof HiosBotError
                ? (error.userMessage || error.message)
                : (error.message || "Unknown error");
            results.failed.push({
                userId,
                reason,
            });
        }
    }

    return results;
}

export function buildMassBanResultsEmbed(results) {
    let description = `**Mass Ban Results:**\n\n`;

    if (results.successful.length > 0) {
        description += `✅ **Successfully Banned (${results.successful.length}):**\n`;
        results.successful.forEach(result => {
            description += `• ${result.user} (${result.userId})\n`;
        });
        description += '\n';
    }

    if (results.skipped.length > 0) {
        description += `⚠️ **Skipped (${results.skipped.length}):**\n`;
        results.skipped.forEach(result => {
            description += `• ${result.user} - ${result.reason}\n`;
        });
        description += '\n';
    }

    if (results.failed.length > 0) {
        description += `❌ **Failed (${results.failed.length}):**\n`;
        results.failed.forEach(result => {
            description += `• ${result.userId} - ${result.reason}\n`;
        });
    }

    const embed = results.successful.length > 0 ? successEmbed : warningEmbed;

    return embed(
        `🔨 Mass Ban Completed`,
        description
    );
}

export default {
    data: new SlashCommandBuilder()
        .setName("massban")
        .setDescription("Ban multiple users from the server at once")
        .addStringOption(option =>
            option
                .setName("users")
                .setDescription("User IDs or mentions to ban (separated by spaces or commas)")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("Reason for the mass ban")
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option
                .setName("delete_days")
                .setDescription("Number of days of messages to delete (0-7)")
                .setMinValue(0)
                .setMaxValue(7)
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    category: "moderation",
    abuseProtection: { maxAttempts: 3, windowMs: 60_000 },

    async execute(interaction, config, client) {
        const usersInput = interaction.options.getString("users");
        const reason = interaction.options.getString("reason") || "Mass ban - No reason provided";
        const deleteDays = interaction.options.getInteger("delete_days") || 0;

        try {
            const userIds = usersInput
.replace(/<@!?(\d+)>/g, '$1')
.split(/[\s,]+/)
.filter(id => id && /^\d+$/.test(id))
.slice(0, 20);

            if (userIds.length === 0) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please provide valid user IDs or mentions. Maximum 20 users at once.' });
            }

            if (userIds.includes(interaction.user.id)) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You cannot include yourself in a mass ban.' });
            }

            if (userIds.includes(client.user.id)) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You cannot include the bot in a mass ban.' });
            }

            // Destructive action: require explicit confirmation before banning.
            const nonce = createPendingMassBan({
                userIds,
                reason,
                deleteDays,
                guildId: interaction.guildId,
                ownerId: interaction.user.id,
            });

            const deferSuccess = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferSuccess) {
                logger.warn(`Massban interaction defer failed`, {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'massban'
                });
                return;
            }

            const confirmEmbed = warningEmbed(
                '⚠️ Confirm Mass Ban',
                `You are about to ban **${userIds.length}** user(s):\n` +
                userIds.map(id => `• \`${id}\``).join('\n') +
                `\n\n**Reason:** ${reason}` +
                (deleteDays > 0 ? `\n**Delete messages:** last ${deleteDays} day(s)` : '') +
                `\n\nThis cannot be undone. Click **Confirm Ban** to proceed.`,
            );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`massban:confirm:${nonce}:${interaction.user.id}`)
                    .setLabel('Confirm Ban')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`massban:cancel:${nonce}:${interaction.user.id}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary),
            );

            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [confirmEmbed],
                components: [row],
            });

        } catch (error) {
            logger.error("Error in massban command:", error);
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while processing the mass ban. Please try again later.' });
        }
    }
};