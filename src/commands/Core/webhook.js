import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { openWebhookDashboard } from './modules/webhook_dashboard.js';

async function ensureManageGuild(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: 'You need the **Manage Server** permission to manage webhooks.',
    });
    return false;
  }
  return true;
}

export default {
  data: new SlashCommandBuilder()
    .setName('webhook')
    .setDescription('Manage bot-created webhooks for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dashboard')
        .setDescription('Open the interactive webhook dashboard'),
    ),

  async execute(interaction) {
    if (!(await ensureManageGuild(interaction))) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== 'dashboard') {
      return;
    }

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) {
      logger.warn('Webhook dashboard defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'webhook',
      });
      return;
    }

    try {
      await openWebhookDashboard(interaction);
    } catch (error) {
      logger.error('Failed to open webhook dashboard:', error);
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: 'Could not open the webhook dashboard. Please try again.',
      });
    }
  },
};
