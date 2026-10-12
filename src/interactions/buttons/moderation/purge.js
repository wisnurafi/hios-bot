import { MessageFlags } from 'discord.js';
import { createEmbed, successEmbed } from '../../../utils/embeds.js';
import { executePurge } from '../../../commands/Moderation/purge.js';
import { logger } from '../../../utils/logger.js';
import { ErrorTypes, replyUserError, handleInteractionError } from '../../../utils/errorHandler.js';

export const purgeConfirmHandler = {
  name: 'purge',
  async execute(interaction, client, args = []) {
    try {
      const [action, channelId, amountRaw, ownerId] = args;

      if (ownerId && interaction.user.id !== ownerId) {
        return await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'Only the moderator who ran this command can confirm it.',
        }).catch(() => {});
      }

      if (action === 'cancel') {
        await interaction.deferUpdate().catch(() => {});
        await interaction.editReply({
          embeds: [createEmbed({
            title: '❌ Cancelled',
            description: 'Purge cancelled. No messages were deleted.',
            color: 'error',
          })],
          components: [],
        }).catch(() => {});
        return;
      }

      if (action !== 'confirm') {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Unknown purge action.',
        }).catch(() => {});
      }

      const amount = Number.parseInt(amountRaw, 10);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Invalid purge amount.',
        }).catch(() => {});
      }

      const channel = interaction.guild?.channels.cache.get(channelId) || interaction.channel;
      if (!channel) {
        return await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'Channel not found.',
        }).catch(() => {});
      }

      await interaction.deferUpdate().catch(() => {});

      try {
        const { deletedCount } = await executePurge({
          channel,
          amount,
          executor: interaction.user,
          client,
          guild: interaction.guild,
        });

        await interaction.editReply({
          embeds: [
            successEmbed(
              'Messages Purged',
              `Deleted ${deletedCount} messages in ${channel}.`,
            ),
          ],
          components: [],
        }).catch((error) => logger.error('Failed to edit purge result:', error));

        setTimeout(() => {
          interaction.deleteReply().catch((err) =>
            logger.debug('Failed to auto-delete purge response:', err)
          );
        }, 3000);
      } catch (error) {
        logger.error('Purge confirm error:', error);
        await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'An unexpected error occurred during message deletion. Note: Messages older than 14 days cannot be bulk deleted.',
        }).catch(() => {});
      }
    } catch (error) {
      await handleInteractionError(interaction, error, {
        type: 'button',
        handler: 'purge',
        customId: interaction.customId,
      });
    }
  },
};

export default purgeConfirmHandler;
