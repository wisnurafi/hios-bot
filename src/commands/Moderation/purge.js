import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export async function executePurge({ channel, amount, executor, client, guild }) {
  const fetched = await channel.messages.fetch({ limit: amount });
  const deleted = await channel.bulkDelete(fetched, true);
  const deletedCount = deleted.size;

  await logEvent({
    client,
    guild,
    event: {
      action: "Messages Purged",
      target: `${channel} (${deletedCount} messages)`,
      executor: `${executor.tag} (${executor.id})`,
      reason: `Deleted ${deletedCount} messages`,
      metadata: {
        channelId: channel.id,
        messageCount: deletedCount,
        requestedAmount: amount,
        moderatorId: executor.id
      }
    }
  });

  return { deletedCount };
}

export default {
    data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete a specific amount of messages")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Number of messages (1-100)")
        .setRequired(true),
    )
.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: "moderation",
  abuseProtection: { maxAttempts: 5, windowMs: 60_000 },

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferSuccess) {
      logger.warn(`Purge interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'purge'
      });
      return;
    }

    const amount = interaction.options.getInteger("amount");
    const channel = interaction.channel;

    if (amount < 1 || amount > 100)
      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please specify a number between 1 and 100.' });

    try {
      // Destructive action: require explicit confirmation before deleting.
      const confirmEmbed = warningEmbed(
        '⚠️ Confirm Purge',
        `You are about to delete **${amount}** message(s) in ${channel}.\n\n` +
        `Messages older than 14 days cannot be bulk deleted.\n\n` +
        `This cannot be undone. Click **Confirm Purge** to proceed.`,
      );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`purge:confirm:${channel.id}:${amount}:${interaction.user.id}`)
          .setLabel('Confirm Purge')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`purge:cancel:${channel.id}:${amount}:${interaction.user.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [confirmEmbed],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Purge command error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An unexpected error occurred. Please try again.' });
    }
  }
};