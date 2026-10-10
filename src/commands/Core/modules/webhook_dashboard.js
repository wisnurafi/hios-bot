// webhook_dashboard.js
// Interactive ephemeral dashboard for managing bot-created webhooks.
// Opened via /webhook dashboard. Single-command design: everything
// (create, move, copy link, test, rename, avatar, delete) lives here.
//
// Collector-managed components (prefix wh_dash_) — skipped by the global
// interaction router (see src/utils/collectorComponents.js). Modals use the
// inline-awaited pattern (wh_dash_modal: prefix, see interactionCreate.js).

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import axios from 'axios';
import crypto from 'crypto';
import { getFromDb, setInDb } from '../../../utils/database/wrapper.js';
import { getManagedWebhooksKey } from '../../../utils/database/keys.js';
import {
  createEmbed,
  successEmbed,
  errorEmbed,
  infoEmbed,
} from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';

const DASHBOARD_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 60 * 1000;
const CID = (...parts) => `wh_dash_${parts.join(':')}`;

// Pending multi-step state, keyed by `${guildId}:${userId}`.
// Entries auto-expire after 5 minutes so abandoned flows don't linger.
const sessions = new Map();

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function setSession(guildId, userId, value) {
  const key = sessionKey(guildId, userId);
  const existing = sessions.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => sessions.delete(key), 5 * 60 * 1000);
  timer.unref?.();
  sessions.set(key, { ...value, timer });
}

function getSession(guildId, userId) {
  return sessions.get(sessionKey(guildId, userId)) || null;
}

function clearSession(guildId, userId) {
  const key = sessionKey(guildId, userId);
  const existing = sessions.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  sessions.delete(key);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function loadRecords(guildId) {
  const records = await getFromDb(getManagedWebhooksKey(guildId), []);
  return Array.isArray(records) ? records : [];
}

async function saveRecords(guildId, records) {
  await setInDb(getManagedWebhooksKey(guildId), records);
}

function findRecord(records, key) {
  return records.find((r) => r.key === key) || null;
}

// Drop records whose webhook no longer exists on Discord (self-healing).
async function pruneRecords(client, guildId, records) {
  const kept = [];
  for (const record of records) {
    try {
      await client.fetchWebhook(record.webhookId);
      kept.push(record);
    } catch {
      logger.warn(`Pruning stale managed webhook ${record.webhookId} (${record.name})`, {
        event: 'webhook.prune',
        guildId,
      });
    }
  }
  if (kept.length !== records.length) {
    await saveRecords(guildId, kept);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Validation & helpers
// ---------------------------------------------------------------------------

function validateName(raw) {
  const name = (raw || '').trim();
  if (name.length < 1 || name.length > 80) {
    throw new Error('Webhook name must be 1-80 characters.');
  }
  if (name.toLowerCase() === 'clyde') {
    throw new Error('Webhook name cannot be "clyde" (reserved by Discord).');
  }
  if (name.toLowerCase().includes('discord')) {
    throw new Error('Webhook name cannot contain "discord" (rejected by Discord).');
  }
  return name;
}

async function fetchAvatarBuffer(url) {
  let res;
  try {
    res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15_000,
      maxContentLength: 8 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`Could not download image: ${err.message}`);
  }
  const contentType = res.headers?.['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('URL did not return an image.');
  }
  return Buffer.from(res.data);
}

function webhookUrl(record) {
  return `https://discord.com/api/webhooks/${record.webhookId}/${record.token}`;
}

function canManageWebhooks(channel) {
  return !!channel?.permissionsFor?.(channel.guild.members.me)?.has(PermissionFlagsBits.ManageWebhooks);
}

function describeRecord(record) {
  return `**${record.name}** → <#${record.channelId}>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function mainView(guild, records) {
  const embed = createEmbed({
    title: '🔗 Webhook Dashboard',
    description: `Manage bot-created webhooks for **${guild.name}**.\nCreate one webhook per target channel, then copy its link for external use (e.g. My-Kait notifications).`,
    color: 'primary',
    fields: [
      {
        name: `Managed webhooks (${records.length})`,
        value: records.length
          ? records.map((r) => `• ${describeRecord(r)} — <@${r.createdBy}>`).join('\n')
          : '_None yet. Click **Create Webhook** to make one._',
      },
    ],
    footer: { text: 'Dashboard closes after 10 minutes of inactivity • Links are secret — only shown to you' },
  });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('create')).setLabel('Create Webhook').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CID('refresh')).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID('close')).setLabel('Close').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );

  const components = [buttons];

  if (records.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(CID('pick'))
      .setPlaceholder('Select a webhook to manage...')
      .addOptions(
        records.slice(0, 25).map((r) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(r.name.slice(0, 100))
            .setDescription(`#${r.channelId}`.slice(0, 100))
            .setValue(r.key)
            .setEmoji('🔗'),
        ),
      );
    components.unshift(new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components };
}

function detailView(record) {
  const embed = createEmbed({
    title: `🔗 ${record.name}`,
    description: `Target channel: <#${record.channelId}>\nCreated by <@${record.createdBy}> on <t:${Math.floor(record.createdAt / 1000)}:d>`,
    color: 'primary',
    fields: [
      {
        name: 'Webhook URL',
        value: 'Use **Copy Link** below — the URL is secret and only shown to you.',
      },
    ],
    footer: { text: 'Dashboard closes after 10 minutes of inactivity' },
  });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('copy', record.key)).setLabel('Copy Link').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(CID('test', record.key)).setLabel('Test Send').setEmoji('🧪').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID('move', record.key)).setLabel('Move Channel').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('avatar', record.key)).setLabel('Change Avatar').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID('rename', record.key)).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID('delete', record.key)).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('back')).setLabel('Back to list').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

function channelPickView(title, description, customId) {
  const embed = createEmbed({ title, description, color: 'primary' });
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Select a target channel...')
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  const cancel = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('back')).setLabel('Cancel').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), cancel] };
}

async function ephemeralError(interaction, message) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ embeds: [errorEmbed('Webhook Error', message)], flags: MessageFlags.Ephemeral }).catch(() => {});
  } else {
    await interaction.reply({ embeds: [errorEmbed('Webhook Error', message)], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function handleCreateModal(interaction, guildId, userId) {
  const modal = new ModalBuilder()
    .setCustomId('wh_dash_modal:create')
    .setTitle('Create Webhook')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Webhook name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setPlaceholder('e.g. My-Kait Notifications'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('avatarUrl')
          .setLabel('Avatar image URL (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://... (leave empty to upload later)'),
      ),
    );

  await interaction.showModal(modal);

  const submitted = await interaction
    .awaitModalSubmit({
      filter: (m) => m.customId === 'wh_dash_modal:create' && m.user.id === userId,
      time: 120_000,
    })
    .catch(() => null);

  if (!submitted) {
    return;
  }

  let name;
  try {
    name = validateName(submitted.fields.getTextInputValue('name'));
  } catch (err) {
    await ephemeralError(submitted, err.message);
    return;
  }
  const avatarUrl = (submitted.fields.getTextInputValue('avatarUrl') || '').trim();

  setSession(guildId, userId, { name, avatarUrl });

  await submitted.deferUpdate().catch(() => {});
  await interaction.editReply(
    channelPickView(
      '➕ Create Webhook',
      `**${name}** — now pick the target channel. The webhook will be created there.`,
      CID('createch'),
    ),
  ).catch(() => {});
}

async function handleCreateChannel(interaction, client, guildId, userId) {
  const channelId = interaction.values?.[0];
  const session = getSession(guildId, userId);
  if (!channelId || !session) {
    await ephemeralError(interaction, 'Session expired. Please start over.');
    return;
  }

  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel || !canManageWebhooks(channel)) {
    await ephemeralError(interaction, `I need the **Manage Webhooks** permission in <#${channelId}>.`);
    return;
  }

  await interaction.deferUpdate().catch(() => {});

  let avatar;
  if (session.avatarUrl) {
    try {
      avatar = await fetchAvatarBuffer(session.avatarUrl);
    } catch (err) {
      await ephemeralError(interaction, `Avatar: ${err.message} — webhook not created.`);
      return;
    }
  }

  let webhook;
  try {
    webhook = await channel.createWebhook({ name: session.name, avatar });
  } catch (err) {
    logger.error('Failed to create webhook:', err);
    await ephemeralError(interaction, `Discord rejected the webhook: ${err.message}`);
    return;
  }

  const record = {
    key: crypto.randomUUID(),
    webhookId: webhook.id,
    token: webhook.token,
    name: webhook.name,
    channelId: channel.id,
    createdBy: userId,
    createdAt: Date.now(),
  };

  const records = await loadRecords(guildId);
  records.push(record);
  await saveRecords(guildId, records);
  clearSession(guildId, userId);

  logger.info(`Managed webhook created: ${record.name} in #${channel.name}`, {
    event: 'webhook.created',
    guildId,
    userId,
  });

  await interaction.editReply(detailView(record)).catch(() => {});
  await interaction.followUp({
    embeds: [successEmbed('Webhook Created', `${describeRecord(record)}\nUse **Copy Link** to grab its URL.`)],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function handleCopy(interaction, records, key) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }
  // Never log the token — URL only goes to this ephemeral message.
  // Direct reply (instant, no defer needed).
  await interaction.reply({
    content: `🔗 **${record.name}** → <#${record.channelId}>\n\`\`\`\n${webhookUrl(record)}\n\`\`\``,
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function handleTest(interaction, client, records, key) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  try {
    const webhook = await client.fetchWebhook(record.webhookId, record.token);
    await webhook.send({
      content: `🔔 Test message from **${record.name}** — this webhook is managed by hios-bot.`,
    });
    await interaction.followUp({
      embeds: [successEmbed('Test Sent', `Check <#${record.channelId}> — the test message should be there.`)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  } catch (err) {
    logger.error('Webhook test send failed:', err);
    await ephemeralError(interaction, `Could not send via webhook: ${err.message}`);
  }
}

async function handleMoveChannel(interaction, client, guildId, records, key) {
  const channelId = interaction.values?.[0];
  const record = findRecord(records, key);
  if (!channelId || !record) {
    await ephemeralError(interaction, 'Session expired. Please start over.');
    return;
  }

  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel || !canManageWebhooks(channel)) {
    await ephemeralError(interaction, `I need the **Manage Webhooks** permission in <#${channelId}>.`);
    return;
  }

  await interaction.deferUpdate().catch(() => {});

  try {
    const old = await client.fetchWebhook(record.webhookId, record.token);
    let avatar;
    const avatarUrl = old.avatarURL({ extension: 'png', size: 128 });
    if (avatarUrl) {
      try {
        avatar = await fetchAvatarBuffer(avatarUrl);
      } catch {
        avatar = undefined; // keep going without avatar rather than failing the move
      }
    }

    const created = await channel.createWebhook({ name: record.name, avatar });
    await old.delete('Moved to another channel via webhook dashboard').catch(() => {});

    record.webhookId = created.id;
    record.token = created.token;
    record.name = created.name;
    record.channelId = channel.id;
    await saveRecords(guildId, records);

    logger.info(`Managed webhook moved: ${record.name} → #${channel.name}`, {
      event: 'webhook.moved',
      guildId,
      userId: interaction.user.id,
    });

    await interaction.editReply(detailView(record)).catch(() => {});
    await interaction.followUp({
      embeds: [successEmbed('Webhook Moved', `${describeRecord(record)}\nThe URL changed — use **Copy Link** to grab the new one.`)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  } catch (err) {
    logger.error('Failed to move webhook:', err);
    await ephemeralError(interaction, `Could not move webhook: ${err.message}`);
  }
}

async function handleRenameModal(interaction, client, guildId, userId, records, key) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`wh_dash_modal:rename:${key}`)
    .setTitle('Rename Webhook')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('New name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(record.name),
      ),
    );

  await interaction.showModal(modal);

  const submitted = await interaction
    .awaitModalSubmit({
      filter: (m) => m.customId === `wh_dash_modal:rename:${key}` && m.user.id === userId,
      time: 120_000,
    })
    .catch(() => null);
  if (!submitted) {
    return;
  }

  let name;
  try {
    name = validateName(submitted.fields.getTextInputValue('name'));
  } catch (err) {
    await ephemeralError(submitted, err.message);
    return;
  }

  await submitted.deferUpdate().catch(() => {});
  try {
    const webhook = await client.fetchWebhook(record.webhookId, record.token);
    await webhook.edit({ name });
    record.name = name;
    await saveRecords(guildId, records);
    await interaction.editReply(detailView(record)).catch(() => {});
  } catch (err) {
    logger.error('Failed to rename webhook:', err);
    await ephemeralError(submitted, `Could not rename webhook: ${err.message}`);
  }
}

async function handleAvatarMenu(interaction, records, key) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }
  const embed = createEmbed({
    title: `🖼️ Avatar — ${record.name}`,
    description: 'Pick how to set the avatar:',
    color: 'primary',
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('avlink', key)).setLabel('Via Link').setEmoji('🔗').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(CID('avup', key)).setLabel('Upload Image').setEmoji('📤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID('avrm', key)).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );
  const back = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('detail', key)).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row, back] }).catch(() => {});
}

async function applyAvatar(interaction, client, guildId, records, key, buffer) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }
  try {
    const webhook = await client.fetchWebhook(record.webhookId, record.token);
    await webhook.edit({ avatar: buffer });
    logger.info(`Avatar updated for managed webhook ${record.name}`, { event: 'webhook.avatar', guildId });
    await interaction.editReply(detailView(record)).catch(() => {});
    await interaction.followUp({
      embeds: [successEmbed('Avatar Updated', `Avatar for **${record.name}** updated.`)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  } catch (err) {
    logger.error('Failed to update webhook avatar:', err);
    await ephemeralError(interaction, `Could not update avatar: ${err.message}`);
  }
}

async function handleAvatarLinkModal(interaction, client, guildId, userId, records, key) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`wh_dash_modal:avlink:${key}`)
    .setTitle('Avatar via Link')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('avatarUrl')
          .setLabel('Image URL')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('https://...'),
      ),
    );

  await interaction.showModal(modal);

  const submitted = await interaction
    .awaitModalSubmit({
      filter: (m) => m.customId === `wh_dash_modal:avlink:${key}` && m.user.id === userId,
      time: 120_000,
    })
    .catch(() => null);
  if (!submitted) {
    return;
  }

  const url = (submitted.fields.getTextInputValue('avatarUrl') || '').trim();
  await submitted.deferUpdate().catch(() => {});
  try {
    const buffer = await fetchAvatarBuffer(url);
    await applyAvatar(submitted, client, guildId, records, key, buffer);
  } catch (err) {
    await ephemeralError(submitted, `Avatar: ${err.message}`);
  }
}

async function handleAvatarUpload(interaction, client, guildId, userId, records, key) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }

  await interaction.deferUpdate().catch(() => {});

  await interaction.followUp({
    embeds: [infoEmbed('Upload Avatar', `Send an image in <#${interaction.channelId}> within 60 seconds.\nIt will become the avatar of **${record.name}**.`)],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});

  const channel = interaction.channel;
  if (!channel?.awaitMessages) {
    await ephemeralError(interaction, 'Cannot listen for uploads in this context.');
    return;
  }

  const collected = await channel
    .awaitMessages({
      filter: (m) => m.author.id === userId && m.attachments.size > 0,
      max: 1,
      time: UPLOAD_TIMEOUT_MS,
      errors: ['time'],
    })
    .catch(() => null);

  const message = collected?.first();
  const attachment = message?.attachments.first();
  if (!attachment) {
    await interaction.followUp({
      embeds: [infoEmbed('Upload Cancelled', 'No image received in time.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  await interaction.deferUpdate().catch(() => {});
  try {
    const buffer = await fetchAvatarBuffer(attachment.url);
    await applyAvatar(interaction, client, guildId, records, key, buffer);
  } catch (err) {
    await ephemeralError(interaction, `Avatar: ${err.message}`);
  } finally {
    message.delete().catch(() => {});
  }
}

async function handleDeleteConfirm(interaction, client, guildId, records, key) {
  const record = findRecord(records, key);
  if (!record) {
    await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
    return;
  }

  const embed = createEmbed({
    title: '🗑️ Delete Webhook',
    description: `Delete **${record.name}** (→ <#${record.channelId}>)?\nThis cannot be undone. External integrations using its URL will stop working.`,
    color: 'error',
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID('delyes', key)).setLabel('Yes, delete').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(CID('detail', key)).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
}

async function handleDeleteYes(interaction, client, guildId, userId, records, key) {
  const record = findRecord(records, key);
  await interaction.deferUpdate().catch(() => {});
  if (record) {
    try {
      const webhook = await client.fetchWebhook(record.webhookId, record.token);
      await webhook.delete('Deleted via webhook dashboard').catch(() => {});
    } catch {
      // Already gone on Discord — just drop the record.
    }
    await saveRecords(guildId, records.filter((r) => r.key !== key));
    logger.info(`Managed webhook deleted: ${record.name}`, { event: 'webhook.deleted', guildId, userId });
  }
  const fresh = await loadRecords(guildId);
  await interaction.editReply(mainView(interaction.guild, fresh)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Component router
// ---------------------------------------------------------------------------

// Ack-first routing: Discord requires the first ack (showModal / deferUpdate /
// reply) within 3 seconds of the component interaction. DB reads/writes and
// Discord API calls happen AFTER the ack, never before — otherwise a slow DB
// (e.g. Neon waking) or flaky network kills the interaction with
// "Unknown interaction" (10062) / "didn't respond in time".
async function routeComponent(interaction, client, guildId, userId) {
  const raw = interaction.customId.slice('wh_dash_'.length);
  const [action, arg] = raw.split(':');

  switch (action) {
    case 'create':
      // No DB needed at all — show the modal immediately.
      await handleCreateModal(interaction, guildId, userId);
      return;
    case 'createch':
      await handleCreateChannel(interaction, client, guildId, userId);
      return;
    case 'refresh': {
      await interaction.deferUpdate().catch(() => {});
      const records = await pruneRecords(client, guildId, await loadRecords(guildId));
      await interaction.editReply(mainView(interaction.guild, records)).catch(() => {});
      return;
    }
    case 'close':
      // Deleting the message does NOT ack the interaction — defer first.
      await interaction.deferUpdate().catch(() => {});
      clearSession(guildId, userId);
      await interaction.message?.delete().catch(() => {});
      return;
    case 'back': {
      await interaction.deferUpdate().catch(() => {});
      const records = await pruneRecords(client, guildId, await loadRecords(guildId));
      await interaction.editReply(mainView(interaction.guild, records)).catch(() => {});
      return;
    }
    case 'pick': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      const key = interaction.values?.[0];
      const record = findRecord(records, key);
      if (!record) {
        await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
        return;
      }
      await interaction.editReply(detailView(record)).catch(() => {});
      return;
    }
    case 'detail': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      const record = findRecord(records, arg);
      if (!record) {
        await ephemeralError(interaction, 'Webhook not found. It may have been deleted.');
        return;
      }
      await interaction.editReply(detailView(record)).catch(() => {});
      return;
    }
    case 'copy': {
      // Direct reply IS the ack — one necessary DB read, then reply at once.
      const records = await loadRecords(guildId);
      await handleCopy(interaction, records, arg);
      return;
    }
    case 'test': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      await handleTest(interaction, client, records, arg);
      return;
    }
    case 'move': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      await interaction.editReply(
        channelPickView(
          '🔀 Move Webhook',
          `Pick the new target channel for **${findRecord(records, arg)?.name ?? 'webhook'}**. A new webhook URL will be generated.`,
          CID('movech', arg),
        ),
      ).catch(() => {});
      return;
    }
    case 'movech': {
      const records = await loadRecords(guildId);
      await handleMoveChannel(interaction, client, guildId, records, arg);
      return;
    }
    case 'avatar': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      await handleAvatarMenu(interaction, records, arg);
      return;
    }
    case 'avlink': {
      // Needs the record for the existence check — the one unavoidable DB
      // read before showModal (showModal itself is the ack and must be the
      // first response, so it can't be preceded by a defer).
      const records = await loadRecords(guildId);
      await handleAvatarLinkModal(interaction, client, guildId, userId, records, arg);
      return;
    }
    case 'avup': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      await handleAvatarUpload(interaction, client, guildId, userId, records, arg);
      return;
    }
    case 'avrm': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      await applyAvatar(interaction, client, guildId, records, arg, null);
      return;
    }
    case 'rename': {
      // Needs the record to prefill the modal — see 'avlink' note above.
      const records = await loadRecords(guildId);
      await handleRenameModal(interaction, client, guildId, userId, records, arg);
      return;
    }
    case 'delete': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      await handleDeleteConfirm(interaction, client, guildId, records, arg);
      return;
    }
    case 'delyes': {
      await interaction.deferUpdate().catch(() => {});
      const records = await loadRecords(guildId);
      await handleDeleteYes(interaction, client, guildId, userId, records, arg);
      return;
    }
    default:
      logger.warn(`Unknown webhook dashboard action: ${action}`, { event: 'webhook.unknown_action', guildId, userId });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function openWebhookDashboard(rootInteraction) {
  const { client, guild, user } = rootInteraction;
  const guildId = guild.id;
  const userId = user.id;

  let records = await loadRecords(guildId);
  records = await pruneRecords(client, guildId, records);

  const reply = await rootInteraction.editReply(mainView(guild, records));
  const message = reply?.id ? reply : await rootInteraction.fetchReply().catch(() => null);
  if (!message) {
    return;
  }

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === userId && i.customId.startsWith('wh_dash_'),
    time: DASHBOARD_TIMEOUT_MS,
  });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
        await routeComponent(interaction, client, guildId, userId);
      }
    } catch (err) {
      logger.error('Webhook dashboard interaction failed:', err);
      await ephemeralError(interaction, 'Something went wrong. Please try again.');
    }
  });

  collector.on('end', async () => {
    clearSession(guildId, userId);
    // Auto-close: remove the ephemeral dashboard.
    const msg = await rootInteraction.fetchReply().catch(() => null);
    await msg?.delete().catch(() => {});
  });
}
