import { createEmbed } from '../../../utils/embeds.js';
import { executeMassBan, buildMassBanResultsEmbed, takePendingMassBan } from '../../../commands/Moderation/massban.js';
import { logger } from '../../../utils/logger.js';
import { ErrorTypes, replyUserError, handleInteractionError } from '../../../utils/errorHandler.js';

export const massbanConfirmHandler = {
  name: 'massban',
  async execute(interaction, client, args = []) {
    try {
      const [action, nonce, ownerId] = args;

      if (ownerId && interaction.user.id !== ownerId) {
        return await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'Only the moderator who ran this command can confirm it.',
        }).catch(() => {});
      }

      const pending = takePendingMassBan(nonce, interaction.user.id);

      if (action === 'cancel' || !pending) {
        await interaction.deferUpdate().catch(() => {});
        await interaction.editReply({
          embeds: [createEmbed({
            title: '❌ Cancelled',
            description: action === 'cancel'
              ? 'Mass ban cancelled. No users were banned.'
              : 'Confirmation expired. Please run the command again.',
            color: 'error',
          })],
          components: [],
        }).catch(() => {});
        return;
      }

      if (action !== 'confirm') {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Unknown mass ban action.',
        }).catch(() => {});
      }

      await interaction.deferUpdate().catch(() => {});

      const results = await executeMassBan({
        client,
        guild: interaction.guild,
        userIds: pending.userIds,
        reason: pending.reason,
        deleteDays: pending.deleteDays,
        executor: interaction.user,
      });

      await interaction.editReply({
        embeds: [buildMassBanResultsEmbed(results)],
        components: [],
      }).catch((error) => logger.error('Failed to edit mass ban results:', error));
    } catch (error) {
      await handleInteractionError(interaction, error, {
        type: 'button',
        handler: 'massban',
        customId: interaction.customId,
      });
    }
  },
};

export default massbanConfirmHandler;
