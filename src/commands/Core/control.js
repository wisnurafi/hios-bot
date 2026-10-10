import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { createEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import {
  loadControlLockdown,
  saveControlLockdown,
} from '../../utils/controlLockdown.js';

async function ensureManageGuild(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: 'You need the **Manage Server** permission to configure control lockdown.',
    });
    return false;
  }
  return true;
}

function addCrudSubcommands(group, kind, labels) {
  const addOption = (sub) => {
    if (kind === 'channel') {
      return sub.addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel to allow/deny')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      );
    }
    if (kind === 'user') {
      return sub.addUserOption((option) =>
        option.setName('user').setDescription('User to allow/deny').setRequired(true),
      );
    }
    return sub.addStringOption((option) =>
      option
        .setName('command')
        .setDescription('Slash command name (e.g. verify)')
        .setRequired(true)
        .setAutocomplete(true),
    );
  };

  return group
    .addSubcommand((sub) => addOption(sub.setName('add').setDescription(labels.add)))
    .addSubcommand((sub) => addOption(sub.setName('remove').setDescription(labels.remove)))
    .addSubcommand((sub) => sub.setName('list').setDescription(labels.list))
    .addSubcommand((sub) => sub.setName('clear').setDescription(labels.clear));
}

async function handleChannel(interaction, sub, guildId) {
  const lockdown = await loadControlLockdown(guildId);

  if (sub === 'list') {
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [
        createEmbed({
          title: '🔒 Allowed Control Channels',
          description:
            lockdown.channels.length > 0
              ? lockdown.channels.map((id) => `• <#${id}>`).join('\n')
              : '_No restriction — commands work in every channel._',
          color: 'primary',
        }),
      ],
    });
  }

  if (sub === 'clear') {
    lockdown.channels = [];
    await saveControlLockdown(guildId, lockdown);
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Channel Allowlist Cleared', 'No channel restriction — commands work everywhere.')],
    });
  }

  const channel = interaction.options.getChannel('channel', true);
  if (sub === 'add') {
    if (!lockdown.channels.includes(channel.id)) {
      lockdown.channels.push(channel.id);
      await saveControlLockdown(guildId, lockdown);
    }
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Channel Allowed', `<#${channel.id}> added — the bot can now be controlled there.`)],
    });
  }

  // remove
  lockdown.channels = lockdown.channels.filter((id) => id !== channel.id);
  await saveControlLockdown(guildId, lockdown);
  return InteractionHelper.safeEditReply(interaction, {
    embeds: [successEmbed('Channel Removed', `<#${channel.id}> removed from the allowlist.`)],
  });
}

async function handleUser(interaction, sub, guildId) {
  const lockdown = await loadControlLockdown(guildId);

  if (sub === 'list') {
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [
        createEmbed({
          title: '🔒 Allowed Controllers',
          description:
            lockdown.users.length > 0
              ? lockdown.users.map((id) => `• <@${id}>`).join('\n')
              : '_No restriction — anyone can control the bot (subject to command permissions)._',
          color: 'primary',
        }),
      ],
    });
  }

  if (sub === 'clear') {
    lockdown.users = [];
    await saveControlLockdown(guildId, lockdown);
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('User Allowlist Cleared', 'No user restriction — anyone can control the bot.')],
    });
  }

  const user = interaction.options.getUser('user', true);
  if (sub === 'add') {
    if (!lockdown.users.includes(user.id)) {
      lockdown.users.push(user.id);
      await saveControlLockdown(guildId, lockdown);
    }
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Controller Added', `<@${user.id}> can now control the bot.`)],
    });
  }

  // remove
  lockdown.users = lockdown.users.filter((id) => id !== user.id);
  await saveControlLockdown(guildId, lockdown);
  return InteractionHelper.safeEditReply(interaction, {
    embeds: [successEmbed('Controller Removed', `<@${user.id}> removed from the allowlist.`)],
  });
}

async function handleExcept(interaction, sub, guildId, client) {
  const lockdown = await loadControlLockdown(guildId);

  if (sub === 'list') {
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [
        createEmbed({
          title: '🔒 Excepted Commands',
          description:
            lockdown.except.length > 0
              ? lockdown.except.map((name) => `• \`/${name}\``).join('\n')
              : '_None — every command is subject to the lockdown._',
          color: 'primary',
          footer: { text: 'Excepted commands bypass the lockdown entirely' },
        }),
      ],
    });
  }

  if (sub === 'clear') {
    lockdown.except = [];
    await saveControlLockdown(guildId, lockdown);
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Exceptions Cleared', 'No command is excepted from the lockdown.')],
    });
  }

  const name = interaction.options.getString('command', true).toLowerCase().trim();
  if (!client.commands.has(name)) {
    return replyUserError(interaction, {
      type: ErrorTypes.USER_INPUT,
      message: `Unknown command \`/${name}\`. Pick one from the autocomplete suggestions.`,
    });
  }

  if (sub === 'add') {
    if (!lockdown.except.includes(name)) {
      lockdown.except.push(name);
      await saveControlLockdown(guildId, lockdown);
    }
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Command Excepted', `\`/${name}\` now bypasses the control lockdown.`)],
    });
  }

  // remove
  lockdown.except = lockdown.except.filter((n) => n !== name);
  await saveControlLockdown(guildId, lockdown);
  return InteractionHelper.safeEditReply(interaction, {
    embeds: [successEmbed('Exception Removed', `\`/${name}\` is subject to the lockdown again.`)],
  });
}

async function handleStatus(interaction, guildId) {
  const lockdown = await loadControlLockdown(guildId);
  const active = lockdown.channels.length > 0 || lockdown.users.length > 0;
  return InteractionHelper.safeEditReply(interaction, {
    embeds: [
      createEmbed({
        title: '🔒 Control Lockdown Status',
        description: active
          ? '**Lockdown is ACTIVE.**'
          : '**Lockdown is OFF** — no channel or user restrictions.',
        color: active ? 'warning' : 'success',
        fields: [
          {
            name: 'Allowed channels',
            value:
              lockdown.channels.length > 0
                ? lockdown.channels.map((id) => `<#${id}>`).join(' ')
                : '_No restriction_',
            inline: false,
          },
          {
            name: 'Allowed users',
            value:
              lockdown.users.length > 0
                ? lockdown.users.map((id) => `<@${id}>`).join(' ')
                : '_No restriction_',
            inline: false,
          },
          {
            name: 'Excepted commands',
            value:
              lockdown.except.length > 0
                ? lockdown.except.map((n) => `\`/${n}\``).join(' ')
                : '_None_',
            inline: false,
          },
        ],
        footer: { text: 'Bot owners always bypass the lockdown' },
      }),
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('control')
    .setDescription('Restrict where and by whom this bot can be controlled')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommandGroup((group) =>
      addCrudSubcommands(group.setName('channel').setDescription('Manage allowed control channels'), 'channel', {
        add: 'Allow bot control in a channel',
        remove: 'Remove a channel from the allowlist',
        list: 'List allowed control channels',
        clear: 'Clear the channel allowlist (no channel restriction)',
      }),
    )
    .addSubcommandGroup((group) =>
      addCrudSubcommands(group.setName('user').setDescription('Manage who can control the bot'), 'user', {
        add: 'Allow a user to control the bot',
        remove: 'Remove a user from the allowlist',
        list: 'List allowed controllers',
        clear: 'Clear the user allowlist (no user restriction)',
      }),
    )
    .addSubcommandGroup((group) =>
      addCrudSubcommands(group.setName('except').setDescription('Manage commands that bypass the lockdown'), 'except', {
        add: 'Except a command from the lockdown',
        remove: 'Remove a command exception',
        list: 'List excepted commands',
        clear: 'Clear all command exceptions',
      }),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('Show the current control lockdown config'),
    ),

  async autocomplete(interaction, client) {
    try {
      const group = interaction.options.getSubcommandGroup(false);
      if (group !== 'except') {
        return;
      }
      const focused = (interaction.options.getFocused() || '').toLowerCase();
      const names = [...client.commands.keys()]
        .filter((name) => name.toLowerCase().includes(focused))
        .sort()
        .slice(0, 25);
      await interaction.respond(names.map((name) => ({ name: `/${name}`, value: name }))).catch(() => {});
    } catch {
      await interaction.respond([]).catch(() => {});
    }
  },

  async execute(interaction, config, client) {
    if (!(await ensureManageGuild(interaction))) {
      return;
    }

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) {
      logger.warn('Control command defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'control',
      });
      return;
    }

    try {
      const guildId = interaction.guild.id;
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      if (sub === 'status' && !group) {
        return await handleStatus(interaction, guildId);
      }

      switch (group) {
        case 'channel':
          return await handleChannel(interaction, sub, guildId);
        case 'user':
          return await handleUser(interaction, sub, guildId);
        case 'except':
          return await handleExcept(interaction, sub, guildId, client);
        default:
          return await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Unknown subcommand.',
          });
      }
    } catch (error) {
      logger.error('Control command error:', error);
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: 'Failed to update the control lockdown. Please try again.',
      }).catch(() => {});
    }
  },
};
