// tempvoiceInterface.js — TempVoice-style owner control panel for Join-to-Create temp channels.
//
// A persistent `#interface` text channel holds one embed with 15 buttons
// (NAME, LIMIT, PRIVACY, WAITING ROOM, CHAT / TRUST, UNTRUST, INVITE, KICK,
// REGION / BLOCK, UNBLOCK, CLAIM, TRANSFER, DELETE). Only the recorded owner
// of a temporary voice channel may use the actions; everyone else gets an
// ephemeral denial. Dynamic pickers (member lists, regions) are served as
// ephemeral select menus built at click time.

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import {
    getJoinToCreateConfig,
    updateJoinToCreateConfig,
    getTemporaryChannelInfo,
    updateTemporaryChannelInfo,
    unregisterTemporaryChannel,
    formatChannelName,
} from '../utils/database.js';
import { sanitizeInput } from '../utils/validation.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

export const INTERFACE_CHANNEL_NAME = 'interface';
const WAITING_ROOM_NAME = 'Waiting Room';
const MAX_CHANNEL_NAME_LENGTH = 100;

const OWNER_OVERWRITES = {
    Connect: true,
    Speak: true,
    PrioritySpeaker: true,
    MoveMembers: true,
};

// ---------------------------------------------------------------------------
// Panel construction
// ---------------------------------------------------------------------------

const PANEL_BUTTONS = [
    [
        { id: 'name', label: 'NAME', icon: 'name', emoji: '🏷️', style: ButtonStyle.Primary },
        { id: 'limit', label: 'LIMIT', icon: 'limit', emoji: '🔢', style: ButtonStyle.Primary },
        { id: 'privacy', label: 'PRIVACY', icon: 'privacy', emoji: '🔒', style: ButtonStyle.Secondary },
        { id: 'waitingroom', label: 'WAITING ROOM', icon: 'waitingroom', emoji: '🚪', style: ButtonStyle.Secondary },
        { id: 'chat', label: 'CHAT', icon: 'chat', emoji: '💬', style: ButtonStyle.Secondary },
    ],
    [
        { id: 'trust', label: 'TRUST', icon: 'trust', emoji: '✅', style: ButtonStyle.Success },
        { id: 'untrust', label: 'UNTRUST', icon: 'untrust', emoji: '❌', style: ButtonStyle.Secondary },
        { id: 'invite', label: 'INVITE', icon: 'invite', emoji: '📩', style: ButtonStyle.Primary },
        { id: 'kick', label: 'KICK', icon: 'kick', emoji: '🦵', style: ButtonStyle.Danger },
        { id: 'region', label: 'REGION', icon: 'region', emoji: '🌍', style: ButtonStyle.Secondary },
    ],
    [
        { id: 'block', label: 'BLOCK', icon: 'block', emoji: '⛔', style: ButtonStyle.Danger },
        { id: 'unblock', label: 'UNBLOCK', icon: 'unblock', emoji: '🔓', style: ButtonStyle.Secondary },
        { id: 'claim', label: 'CLAIM', icon: 'claim', emoji: '👑', style: ButtonStyle.Primary },
        { id: 'transfer', label: 'TRANSFER', icon: 'transfer', emoji: '🔄', style: ButtonStyle.Primary },
        { id: 'delete', label: 'DELETE', icon: 'delete', emoji: '🗑️', style: ButtonStyle.Danger },
    ],
];

// Flat minimal white icons (Lucide, MIT) uploaded as custom guild emojis so
// the panel buttons don't rely on Unicode emoji. Keys match PANEL_BUTTONS icons.
const INTERFACE_EMOJI_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'assets',
    'interface-emojis'
);
const emojiNameFor = (key) => `hios_tv_${key}`;

/**
 * Ensure the 15 flat panel icons exist as custom emojis in this guild.
 * Idempotent: reuses stored emojis that still exist, uploads only what's
 * missing. Returns a map of icon key -> emoji mention string.
 * Falls back to an empty map (caller uses Unicode emoji) when the bot
 * lacks Manage Emojis permission or an upload fails.
 */
export async function ensureInterfaceEmojis(client, guild) {
    const config = await getJoinToCreateConfig(client, guild.id);
    const stored = (config.interfaceEmojis && typeof config.interfaceEmojis === 'object')
        ? config.interfaceEmojis
        : {};

    const emojis = await guild.emojis.fetch().catch(() => guild.emojis.cache);
    const resolved = {};
    const missing = [];

    for (const row of PANEL_BUTTONS) {
        for (const b of row) {
            const mention = stored[b.icon];
            const id = typeof mention === 'string' ? (mention.match(/:(\d+)>$/) || [])[1] : null;
            if (id && emojis.has(id)) {
                resolved[b.icon] = mention;
            } else {
                missing.push(b.icon);
            }
        }
    }

    if (missing.length === 0) {
        return resolved;
    }

    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers)) {
        logger.warn(
            `TempVoice: missing Manage Emojis permission in guild ${guild.id}, ` +
            'panel will use Unicode emoji fallbacks'
        );
        return resolved;
    }

    const updated = { ...stored };
    for (const key of missing) {
        try {
            const data = await readFile(path.join(INTERFACE_EMOJI_DIR, `${key}.png`));
            const emoji = await guild.emojis.create({ attachment: data, name: emojiNameFor(key) });
            const mention = `<:${emoji.name}:${emoji.id}>`;
            updated[key] = mention;
            resolved[key] = mention;
            logger.info(`TempVoice: uploaded interface emoji ${mention} in guild ${guild.id}`);
        } catch (error) {
            logger.warn(`TempVoice: failed to upload interface emoji "${key}" in guild ${guild.id}: ${error.message}`);
        }
    }

    await updateJoinToCreateConfig(client, guild.id, { interfaceEmojis: updated }).catch((error) => {
        logger.warn(`TempVoice: failed to persist interface emojis in guild ${guild.id}: ${error.message}`);
    });

    return resolved;
}

export function buildInterfacePayload(interfaceEmojis = {}) {
    const em = (b) => interfaceEmojis[b.icon] || b.emoji;
    const legend = PANEL_BUTTONS.map((row) =>
        row.map((b) => `${em(b)} ${b.label}`).join('　')
    ).join('\n');

    const embed = new EmbedBuilder()
        .setTitle('🎙️ TempVoice Interface')
        .setColor(getColor('info'))
        .setDescription(
            'This interface can be used to manage temporary voice channels.\n' +
            'More options are available with /voice commands.\n\n' +
            legend + '\n\n' +
            'Press the buttons below to use the interface'
        );

    const rows = PANEL_BUTTONS.map((row) =>
        new ActionRowBuilder().addComponents(
            row.map((b) =>
                new ButtonBuilder()
                    .setCustomId(`tempvoice:${b.id}`)
                    .setLabel(b.label)
                    .setEmoji(em(b))
                    .setStyle(b.style)
            )
        )
    );

    return { embeds: [embed], components: rows };
}

// ---------------------------------------------------------------------------
// Temp channel state helpers
// ---------------------------------------------------------------------------

export function normalizeTempInfo(raw) {
    const info = raw && typeof raw === 'object' ? raw : {};
    return {
        ownerId: info.ownerId ?? null,
        triggerChannelId: info.triggerChannelId ?? null,
        createdAt: info.createdAt ?? Date.now(),
        trusted: Array.isArray(info.trusted) ? info.trusted.filter((id) => typeof id === 'string') : [],
        blocked: Array.isArray(info.blocked) ? info.blocked.filter((id) => typeof id === 'string') : [],
        locked: info.locked === true,
        chatEnabled: info.chatEnabled !== false,
        waitingRoom: info.waitingRoom && typeof info.waitingRoom === 'object' ? info.waitingRoom : null,
    };
}

export async function updateTempState(client, guildId, channelId, updates) {
    return updateTemporaryChannelInfo(client, guildId, channelId, updates);
}

/**
 * Find the temp voice channel owned by a user. Cleans up stale DB entries
 * whose Discord channel no longer exists.
 * @returns {{ channel, info } | null}
 */
export async function resolveOwnerTempChannel(client, guild, userId) {
    const config = await getJoinToCreateConfig(client, guild.id);
    const entries = Object.entries(config.temporaryChannels || {});

    for (const [channelId, rawInfo] of entries) {
        const info = normalizeTempInfo(rawInfo);
        if (info.ownerId !== userId) continue;

        const channel =
            guild.channels.cache.get(channelId) ??
            (await guild.channels.fetch(channelId).catch(() => null));

        if (!channel) {
            logger.info(`Cleaning stale temp channel record ${channelId} in guild ${guild.id}`);
            await unregisterTemporaryChannel(client, guild.id, channelId).catch(() => {});
            continue;
        }

        return { channel, info };
    }

    return null;
}

/**
 * Owner guard for panel actions. Replies ephemerally and returns null when the
 * clicking user does not own a temp channel.
 */
export async function getOwnerContext(interaction, client) {
    if (!interaction.guild) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ This interface can only be used inside a server.',
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    const resolved = await resolveOwnerTempChannel(client, interaction.guild, interaction.user.id);

    if (!resolved) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ You do not own a temporary voice channel.\nJoin the **Join to Create** voice channel first to get your own room.',
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    return resolved;
}

function sanitizeChannelName(name) {
    return sanitizeInput(String(name || ''), MAX_CHANNEL_NAME_LENGTH)
        .replace(/[\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function renameToTemplate(client, guild, channel, info) {
    try {
        const config = await getJoinToCreateConfig(client, guild.id);
        const channelOptions = config.channelOptions?.[info.triggerChannelId] || {};
        const template = channelOptions.nameTemplate || config.channelNameTemplate || "{username}'s Room";
        const newOwner = await guild.members.fetch(info.ownerId).catch(() => null);
        if (!newOwner) return;

        const newName = sanitizeChannelName(
            formatChannelName(template, {
                username: newOwner.user.username,
                userTag: newOwner.user.tag,
                displayName: newOwner.displayName,
                guildName: guild.name,
            })
        );
        if (newName && newName !== channel.name) {
            await channel.setName(newName).catch((e) => logger.warn(`TempVoice rename failed: ${e.message}`));
        }
    } catch (error) {
        logger.warn(`TempVoice renameToTemplate failed: ${error.message}`);
    }
}

async function swapOwnerOverwrites(channel, oldOwnerId, newOwnerId) {
    if (oldOwnerId && oldOwnerId !== newOwnerId) {
        await channel.permissionOverwrites.delete(oldOwnerId).catch(() => {});
    }
    await channel.permissionOverwrites.edit(newOwnerId, OWNER_OVERWRITES);
}

// ---------------------------------------------------------------------------
// Interface channel lifecycle
// ---------------------------------------------------------------------------

/**
 * Create (or repair) the persistent `#interface` panel channel. Idempotent:
 * reuses the stored channel/message when they still exist, otherwise recreates.
 */
export async function ensureInterfacePanel(client, guild, categoryId = null) {
    const config = await getJoinToCreateConfig(client, guild.id);
    const interfaceEmojis = await ensureInterfaceEmojis(client, guild);
    const payload = buildInterfacePayload(interfaceEmojis);

    if (config.interfaceChannelId) {
        const existing =
            guild.channels.cache.get(config.interfaceChannelId) ??
            (await guild.channels.fetch(config.interfaceChannelId).catch(() => null));

        if (existing && existing.isTextBased()) {
            let message = config.interfaceMessageId
                ? await existing.messages.fetch(config.interfaceMessageId).catch(() => null)
                : null;

            if (message) {
                await message.edit(payload).catch(() => {});
                return { channel: existing, message, created: false };
            }

            message = await existing.send(payload);
            await updateJoinToCreateConfig(client, guild.id, {
                interfaceChannelId: existing.id,
                interfaceMessageId: message.id,
            });
            return { channel: existing, message, created: false };
        }

        logger.info(`TempVoice interface channel ${config.interfaceChannelId} missing, recreating in guild ${guild.id}`);
    }

    const me = guild.members.me;
    const overwrites = [
        {
            id: guild.id,
            allow: [PermissionFlagsBits.ViewChannel],
            deny: [PermissionFlagsBits.SendMessages],
        },
    ];
    if (me) {
        overwrites.push({
            id: me.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ReadMessageHistory,
            ],
        });
    }

    const channel = await guild.channels.create({
        name: INTERFACE_CHANNEL_NAME,
        type: ChannelType.GuildText,
        ...(categoryId ? { parent: categoryId } : {}),
        topic: 'TempVoice control panel — press the buttons below to manage your temporary voice channel.',
        permissionOverwrites: overwrites,
    });

    const message = await channel.send(payload);
    await updateJoinToCreateConfig(client, guild.id, {
        interfaceChannelId: channel.id,
        interfaceMessageId: message.id,
    });

    logger.info(`Created TempVoice interface channel ${channel.id} in guild ${guild.id}`);
    return { channel, message, created: true };
}

// ---------------------------------------------------------------------------
// Ephemeral picker helpers
// ---------------------------------------------------------------------------

function memberSelectOptions(members) {
    return members
        .filter((m) => !m.user.bot)
        .slice(0, 25)
        .map((m) => ({
            label: (m.displayName || m.user.username).substring(0, 100),
            value: m.id,
            description: `@${m.user.username}`.substring(0, 100),
        }));
}

async function replyPicker(interaction, customId, placeholder, options) {
    if (options.length === 0) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Nobody available for this action right now.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options);

    await InteractionHelper.safeReply(interaction, {
        content: placeholder,
        components: [new ActionRowBuilder().addComponents(select)],
        flags: MessageFlags.Ephemeral,
    });
}

export const VOICE_REGIONS = [
    { label: 'Automatic', value: 'auto', emoji: '🌐' },
    { label: 'Brazil', value: 'brazil' },
    { label: 'Hong Kong', value: 'hongkong' },
    { label: 'India', value: 'india' },
    { label: 'Japan', value: 'japan' },
    { label: 'Rotterdam', value: 'rotterdam' },
    { label: 'Singapore', value: 'singapore' },
    { label: 'South Africa', value: 'southafrica' },
    { label: 'Sydney', value: 'sydney' },
    { label: 'US Central', value: 'us-central' },
    { label: 'US East', value: 'us-east' },
    { label: 'US South', value: 'us-south' },
    { label: 'US West', value: 'us-west' },
];

// ---------------------------------------------------------------------------
// Button actions (dispatched from src/interactions/buttons/tempvoice/)
// ---------------------------------------------------------------------------

async function showRenameModal(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const modal = new ModalBuilder()
        .setCustomId('tempvoice_modal:rename')
        .setTitle('Rename Voice Channel');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('channel_name')
                .setLabel('New channel name')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(ctx.channel.name)
                .setMinLength(1)
                .setMaxLength(MAX_CHANNEL_NAME_LENGTH)
                .setRequired(true)
        )
    );

    await InteractionHelper.safeShowModal(interaction, modal);
}

async function showLimitModal(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const modal = new ModalBuilder()
        .setCustomId('tempvoice_modal:limit')
        .setTitle('Set User Limit');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('user_limit')
                .setLabel('User limit (0 = unlimited, max 99)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(`Current: ${ctx.channel.userLimit === 0 ? 'unlimited' : ctx.channel.userLimit}`)
                .setMinLength(1)
                .setMaxLength(2)
                .setRequired(true)
        )
    );

    await InteractionHelper.safeShowModal(interaction, modal);
}

async function togglePrivacy(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const { channel, info } = ctx;
    try {
        if (info.locked) {
            await channel.permissionOverwrites.edit(channel.guild.id, { Connect: true });
            await updateTempState(client, channel.guild.id, channel.id, { locked: false });
            await InteractionHelper.safeEditReply(interaction, {
                content: '🔓 **Channel unlocked** — everyone can join again.',
            });
        } else {
            await channel.permissionOverwrites.edit(channel.guild.id, { Connect: false });
            await updateTempState(client, channel.guild.id, channel.id, { locked: true });
            await InteractionHelper.safeEditReply(interaction, {
                content: '🔒 **Channel locked** — only you and trusted users can join.\nUse TRUST to let specific people in.',
            });
        }
    } catch (error) {
        logger.error(`TempVoice togglePrivacy failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to change privacy. Check my permissions and try again.' });
    }
}

async function toggleWaitingRoom(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const { channel, info } = ctx;
    const guild = channel.guild;

    try {
        if (info.waitingRoom?.channelId) {
            // Disable: move waiters back, delete the room.
            const wrChannel =
                guild.channels.cache.get(info.waitingRoom.channelId) ??
                (await guild.channels.fetch(info.waitingRoom.channelId).catch(() => null));

            if (wrChannel) {
                for (const [, member] of wrChannel.members) {
                    if (member.user.bot) continue;
                    await member.voice.setChannel(channel).catch(() => {});
                }
                await wrChannel.delete('TempVoice waiting room disabled').catch(() => {});
            }

            await updateTempState(client, guild.id, channel.id, { waitingRoom: null });
            await InteractionHelper.safeEditReply(interaction, {
                content: '⏳ **Waiting room disabled** — everyone can join directly again.',
            });
            return;
        }

        const wrChannel = await guild.channels.create({
            name: WAITING_ROOM_NAME,
            type: ChannelType.GuildVoice,
            parent: channel.parentId ?? undefined,
            userLimit: 0,
        });

        await updateTempState(client, guild.id, channel.id, {
            waitingRoom: { enabled: true, channelId: wrChannel.id, createdAt: Date.now() },
        });

        await InteractionHelper.safeEditReply(interaction, {
            content: `⏳ **Waiting room enabled** — new joiners will wait in ${wrChannel} until you INVITE them in.`,
        });
    } catch (error) {
        logger.error(`TempVoice toggleWaitingRoom failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to toggle the waiting room. Check my permissions and try again.' });
    }
}

async function toggleChat(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const { channel, info } = ctx;
    try {
        if (info.chatEnabled) {
            await channel.permissionOverwrites.edit(channel.guild.id, { SendMessages: false });
            await updateTempState(client, channel.guild.id, channel.id, { chatEnabled: false });
            await InteractionHelper.safeEditReply(interaction, {
                content: '💬 **Text chat disabled** for this voice channel.',
            });
        } else {
            await channel.permissionOverwrites.edit(channel.guild.id, { SendMessages: true });
            await updateTempState(client, channel.guild.id, channel.id, { chatEnabled: true });
            await InteractionHelper.safeEditReply(interaction, {
                content: '💬 **Text chat enabled** for this voice channel.',
            });
        }
    } catch (error) {
        logger.error(`TempVoice toggleChat failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to toggle text chat. Check my permissions and try again.' });
    }
}

async function sendTrustPicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const candidates = [...ctx.channel.members.filter(
        (m) => m.id !== ctx.info.ownerId && !ctx.info.trusted.includes(m.id)
    ).values()];
    await replyPicker(
        interaction,
        'tempvoice_select:trust',
        'Select a user to trust (they can join even when the channel is locked)',
        memberSelectOptions(candidates)
    );
}

async function sendUntrustPicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const options = memberSelectOptions(
        ctx.info.trusted
            .map((id) => ctx.channel.guild.members.cache.get(id))
            .filter(Boolean)
    );
    await replyPicker(interaction, 'tempvoice_select:untrust', 'Select a trusted user to remove', options);
}

async function sendInvitePicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const candidates = [...ctx.channel.guild.members.cache.filter(
        (m) => m.voice.channel && m.voice.channel.id !== ctx.channel.id && !m.user.bot
    ).values()];
    await replyPicker(
        interaction,
        'tempvoice_select:invite',
        'Select a user in voice to invite into your channel',
        memberSelectOptions(candidates)
    );
}

async function sendKickPicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const candidates = [...ctx.channel.members.filter((m) => m.id !== ctx.info.ownerId).values()];
    await replyPicker(
        interaction,
        'tempvoice_select:kick',
        'Select a user to kick from your channel',
        memberSelectOptions(candidates)
    );
}

async function sendRegionPicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const select = new StringSelectMenuBuilder()
        .setCustomId('tempvoice_select:region')
        .setPlaceholder('Select a voice region')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(VOICE_REGIONS);

    await InteractionHelper.safeReply(interaction, {
        content: 'Select a voice region for your channel',
        components: [new ActionRowBuilder().addComponents(select)],
        flags: MessageFlags.Ephemeral,
    });
}

async function sendBlockPicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const candidates = [...ctx.channel.members.filter(
        (m) => m.id !== ctx.info.ownerId && !ctx.info.blocked.includes(m.id)
    ).values()];
    await replyPicker(
        interaction,
        'tempvoice_select:block',
        'Select a user to block (they will be disconnected and cannot rejoin)',
        memberSelectOptions(candidates)
    );
}

async function sendUnblockPicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const blockedMembers = ctx.info.blocked
        .map((id) => ctx.channel.guild.members.cache.get(id))
        .filter(Boolean);
    const options = blockedMembers.slice(0, 25).map((m) => ({
        label: (m.displayName || m.user.username).substring(0, 100),
        value: m.id,
        description: `@${m.user.username}`.substring(0, 100),
    }));
    await replyPicker(interaction, 'tempvoice_select:unblock', 'Select a blocked user to unblock', options);
}

async function sendTransferPicker(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const candidates = [...ctx.channel.members.filter((m) => m.id !== ctx.info.ownerId).values()];
    await replyPicker(
        interaction,
        'tempvoice_select:transfer',
        'Select the new owner of your channel',
        memberSelectOptions(candidates)
    );
}

async function claimChannel(interaction, client) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Join the temporary voice channel first, then press CLAIM.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const rawInfo = await getTemporaryChannelInfo(client, interaction.guild.id, voiceChannel.id);
    if (!rawInfo) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ This is not a temporary voice channel.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const info = normalizeTempInfo(rawInfo);
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    try {
        if (info.ownerId === interaction.user.id) {
            await InteractionHelper.safeEditReply(interaction, { content: '👑 You are already the owner of this channel.' });
            return;
        }

        if (voiceChannel.members.has(info.ownerId)) {
            await InteractionHelper.safeEditReply(interaction, {
                content: '❌ The current owner is still in the channel. Ask them to use TRANSFER instead.',
            });
            return;
        }

        const oldOwnerId = info.ownerId;
        await updateTempState(client, interaction.guild.id, voiceChannel.id, { ownerId: interaction.user.id });
        await swapOwnerOverwrites(voiceChannel, oldOwnerId, interaction.user.id);
        await renameToTemplate(client, interaction.guild, voiceChannel, { ...info, ownerId: interaction.user.id });

        await InteractionHelper.safeEditReply(interaction, {
            content: `👑 **Ownership claimed!** You are now the owner of ${voiceChannel}.`,
        });
        logger.info(`TempVoice: ${interaction.user.id} claimed channel ${voiceChannel.id} in guild ${interaction.guild.id}`);
    } catch (error) {
        logger.error(`TempVoice claim failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to claim the channel. Try again.' });
    }
}

async function askDeleteConfirm(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tempvoice:delete_confirm')
            .setLabel('Yes, delete it')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️'),
        new ButtonBuilder()
            .setCustomId('tempvoice:delete_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    await InteractionHelper.safeReply(interaction, {
        content: `⚠️ Delete **${ctx.channel.name}**? Everyone inside will be disconnected. This cannot be undone.`,
        components: [row],
        flags: MessageFlags.Ephemeral,
    });
}

export async function deleteTempChannelCompletely(client, guild, channel, info) {
    const norm = normalizeTempInfo(info);

    if (norm.waitingRoom?.channelId) {
        const wrChannel =
            guild.channels.cache.get(norm.waitingRoom.channelId) ??
            (await guild.channels.fetch(norm.waitingRoom.channelId).catch(() => null));
        if (wrChannel) {
            await wrChannel.delete('TempVoice waiting room cleanup').catch(() => {});
        }
    }

    await unregisterTemporaryChannel(client, guild.id, channel.id);
    await channel.delete('TempVoice channel deleted via interface').catch(() => {});
}

async function confirmDelete(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    try {
        const name = ctx.channel.name;
        await deleteTempChannelCompletely(client, interaction.guild, ctx.channel, ctx.info);
        await InteractionHelper.safeEditReply(interaction, {
            content: `🗑️ **${name}** has been deleted.`,
            components: [],
        });
        logger.info(`TempVoice: ${interaction.user.id} deleted channel ${ctx.channel.id} via interface`);
    } catch (error) {
        logger.error(`TempVoice delete failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to delete the channel.', components: [] });
    }
}

async function cancelDelete(interaction, client) {
    await InteractionHelper.safeReply(interaction, {
        content: 'Cancelled — your channel is safe.',
        flags: MessageFlags.Ephemeral,
    });
    // Remove the buttons from the confirm message when possible.
    await interaction.message?.edit({ components: [] }).catch(() => {});
}

const BUTTON_ACTIONS = {
    name: showRenameModal,
    limit: showLimitModal,
    privacy: togglePrivacy,
    waitingroom: toggleWaitingRoom,
    chat: toggleChat,
    trust: sendTrustPicker,
    untrust: sendUntrustPicker,
    invite: sendInvitePicker,
    kick: sendKickPicker,
    region: sendRegionPicker,
    block: sendBlockPicker,
    unblock: sendUnblockPicker,
    claim: claimChannel,
    transfer: sendTransferPicker,
    delete: askDeleteConfirm,
    delete_confirm: confirmDelete,
    delete_cancel: cancelDelete,
};

export async function dispatchTempVoiceButton(interaction, client, action) {
    const handler = BUTTON_ACTIONS[action];
    if (!handler) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Unknown interface action.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await handler(interaction, client);
}

// ---------------------------------------------------------------------------
// Select menu actions (dispatched from src/interactions/selectMenus/tempvoice/)
// ---------------------------------------------------------------------------

async function selectTrust(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const userId = interaction.values[0];
    const { channel, info } = ctx;

    try {
        const member = await channel.guild.members.fetch(userId).catch(() => null);
        if (!member) {
            await InteractionHelper.safeEditReply(interaction, { content: '❌ User not found.', components: [] });
            return;
        }

        const trusted = info.trusted.includes(userId) ? info.trusted : [...info.trusted, userId];
        await channel.permissionOverwrites.edit(userId, { Connect: true });
        await updateTempState(client, channel.guild.id, channel.id, { trusted });

        await InteractionHelper.safeEditReply(interaction, {
            content: `🤝 **${member.displayName}** is now trusted — they can join even when the channel is locked.`,
            components: [],
        });
    } catch (error) {
        logger.error(`TempVoice trust failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to trust that user.', components: [] });
    }
}

async function selectUntrust(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const userId = interaction.values[0];
    const { channel, info } = ctx;

    try {
        const member = await channel.guild.members.fetch(userId).catch(() => null);
        const trusted = info.trusted.filter((id) => id !== userId);
        await channel.permissionOverwrites.delete(userId).catch(() => {});
        await updateTempState(client, channel.guild.id, channel.id, { trusted });

        await InteractionHelper.safeEditReply(interaction, {
            content: `🚫 **${member ? member.displayName : 'User'}** is no longer trusted.`,
            components: [],
        });
    } catch (error) {
        logger.error(`TempVoice untrust failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to untrust that user.', components: [] });
    }
}

async function selectInvite(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const userId = interaction.values[0];
    const { channel, info } = ctx;

    try {
        const member = await channel.guild.members.fetch(userId).catch(() => null);
        if (!member) {
            await InteractionHelper.safeEditReply(interaction, { content: '❌ User not found.', components: [] });
            return;
        }

        // Invited users bypass the waiting room, so mark them trusted first.
        const trusted = info.trusted.includes(userId) ? info.trusted : [...info.trusted, userId];
        await channel.permissionOverwrites.edit(userId, { Connect: true });
        await updateTempState(client, channel.guild.id, channel.id, { trusted });

        if (member.voice.channel) {
            await member.voice.setChannel(channel, 'Invited via TempVoice interface').catch(() => {});
        }

        await InteractionHelper.safeEditReply(interaction, {
            content: `📨 **${member.displayName}** has been invited to your channel.`,
            components: [],
        });
    } catch (error) {
        logger.error(`TempVoice invite failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to invite that user.', components: [] });
    }
}

async function selectKick(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const userId = interaction.values[0];

    try {
        const member = await ctx.channel.guild.members.fetch(userId).catch(() => null);
        if (!member?.voice.channel || member.voice.channel.id !== ctx.channel.id) {
            await InteractionHelper.safeEditReply(interaction, { content: '❌ That user is no longer in your channel.', components: [] });
            return;
        }

        const name = member.displayName;
        await member.voice.disconnect('Kicked via TempVoice interface');
        await InteractionHelper.safeEditReply(interaction, {
            content: `👢 **${name}** has been kicked from your channel.`,
            components: [],
        });
    } catch (error) {
        logger.error(`TempVoice kick failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to kick that user.', components: [] });
    }
}

async function selectRegion(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const value = interaction.values[0];

    try {
        await ctx.channel.setRTCRegion(value === 'auto' ? null : value);
        const label = VOICE_REGIONS.find((r) => r.value === value)?.label ?? value;
        await InteractionHelper.safeEditReply(interaction, {
            content: `🌐 Voice region set to **${label}**.`,
            components: [],
        });
    } catch (error) {
        logger.error(`TempVoice region failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to change the voice region.', components: [] });
    }
}

async function selectBlock(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const userId = interaction.values[0];
    const { channel, info } = ctx;

    try {
        const member = await channel.guild.members.fetch(userId).catch(() => null);
        if (!member) {
            await InteractionHelper.safeEditReply(interaction, { content: '❌ User not found.', components: [] });
            return;
        }

        const blocked = info.blocked.includes(userId) ? info.blocked : [...info.blocked, userId];
        const trusted = info.trusted.filter((id) => id !== userId);
        await channel.permissionOverwrites.edit(userId, { Connect: false });

        if (member.voice.channel?.id === channel.id) {
            await member.voice.disconnect('Blocked via TempVoice interface').catch(() => {});
        }

        await updateTempState(client, channel.guild.id, channel.id, { blocked, trusted });

        await InteractionHelper.safeEditReply(interaction, {
            content: `⛔ **${member.displayName}** has been blocked — they cannot rejoin your channel.`,
            components: [],
        });
    } catch (error) {
        logger.error(`TempVoice block failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to block that user.', components: [] });
    }
}

async function selectUnblock(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const userId = interaction.values[0];
    const { channel, info } = ctx;

    try {
        const member = await channel.guild.members.fetch(userId).catch(() => null);
        const blocked = info.blocked.filter((id) => id !== userId);
        await channel.permissionOverwrites.delete(userId).catch(() => {});
        await updateTempState(client, channel.guild.id, channel.id, { blocked });

        await InteractionHelper.safeEditReply(interaction, {
            content: `🔓 **${member ? member.displayName : 'User'}** has been unblocked.`,
            components: [],
        });
    } catch (error) {
        logger.error(`TempVoice unblock failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to unblock that user.', components: [] });
    }
}

async function selectTransfer(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const userId = interaction.values[0];
    const { channel, info } = ctx;

    try {
        const member = await channel.guild.members.fetch(userId).catch(() => null);
        if (!member || member.voice.channel?.id !== channel.id) {
            await InteractionHelper.safeEditReply(interaction, { content: '❌ That user is no longer in your channel.', components: [] });
            return;
        }

        const oldOwnerId = info.ownerId;
        await updateTempState(client, channel.guild.id, channel.id, { ownerId: userId });
        await swapOwnerOverwrites(channel, oldOwnerId, userId);
        await renameToTemplate(client, channel.guild, channel, { ...info, ownerId: userId });

        await InteractionHelper.safeEditReply(interaction, {
            content: `🔄 Ownership transferred to **${member.displayName}**.`,
            components: [],
        });
        logger.info(`TempVoice: ${oldOwnerId} transferred channel ${channel.id} to ${userId}`);
    } catch (error) {
        logger.error(`TempVoice transfer failed: ${error.message}`);
        await InteractionHelper.safeEditReply(interaction, { content: '❌ Failed to transfer ownership.', components: [] });
    }
}

const SELECT_ACTIONS = {
    trust: selectTrust,
    untrust: selectUntrust,
    invite: selectInvite,
    kick: selectKick,
    region: selectRegion,
    block: selectBlock,
    unblock: selectUnblock,
    transfer: selectTransfer,
};

export async function dispatchTempVoiceSelect(interaction, client, action) {
    const handler = SELECT_ACTIONS[action];
    if (!handler) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Unknown interface action.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await handler(interaction, client);
}

// ---------------------------------------------------------------------------
// Modal submissions (dispatched from src/interactions/modals/tempvoice/)
// ---------------------------------------------------------------------------

async function submitRename(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const rawName = interaction.fields.getTextInputValue('channel_name');
    const newName = sanitizeChannelName(rawName);

    if (!newName) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Channel name cannot be empty.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    try {
        await ctx.channel.setName(newName);
        await InteractionHelper.safeReply(interaction, {
            content: `✏️ Channel renamed to **${newName}**.`,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        logger.error(`TempVoice rename failed: ${error.message}`);
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Failed to rename the channel.',
            flags: MessageFlags.Ephemeral,
        });
    }
}

async function submitLimit(interaction, client) {
    const ctx = await getOwnerContext(interaction, client);
    if (!ctx) return;

    const raw = interaction.fields.getTextInputValue('user_limit').trim();
    const limit = Number.parseInt(raw, 10);

    if (!Number.isInteger(limit) || limit < 0 || limit > 99) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ User limit must be a number between 0 (unlimited) and 99.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    try {
        await ctx.channel.setUserLimit(limit);
        await InteractionHelper.safeReply(interaction, {
            content: limit === 0
                ? '👥 User limit removed — **unlimited** users can join.'
                : `👥 User limit set to **${limit}** users.`,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        logger.error(`TempVoice limit failed: ${error.message}`);
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Failed to set the user limit.',
            flags: MessageFlags.Ephemeral,
        });
    }
}

const MODAL_ACTIONS = {
    rename: submitRename,
    limit: submitLimit,
};

export async function dispatchTempVoiceModal(interaction, client, action) {
    const handler = MODAL_ACTIONS[action];
    if (!handler) {
        await InteractionHelper.safeReply(interaction, {
            content: '❌ Unknown interface action.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await handler(interaction, client);
}

// ---------------------------------------------------------------------------
// Waiting room enforcement (called from voiceStateUpdate)
// ---------------------------------------------------------------------------

/**
 * Redirects untrusted users who join a temp channel with the waiting room
 * enabled into the waiting room channel. Returns true when a redirect happened.
 */
export async function enforceWaitingRoom(client, oldState, newState, config) {
    try {
        const channel = newState.channel;
        if (!channel) return false;
        if (oldState.channel && oldState.channel.id === channel.id) return false;

        const rawInfo = (config.temporaryChannels || {})[channel.id];
        if (!rawInfo) return false;

        const info = normalizeTempInfo(rawInfo);
        const wr = info.waitingRoom;
        if (!wr?.channelId) return false;

        const member = newState.member;
        if (!member || member.user.bot) return false;
        if (info.ownerId === member.id || info.trusted.includes(member.id)) return false;
        if (oldState.channel && oldState.channel.id === wr.channelId) return false;

        const guild = newState.guild;
        const wrChannel =
            guild.channels.cache.get(wr.channelId) ??
            (await guild.channels.fetch(wr.channelId).catch(() => null));

        if (!wrChannel) {
            // Waiting room was deleted manually — drop the stale state.
            await updateTempState(client, guild.id, channel.id, { waitingRoom: null });
            return false;
        }

        if (member.voice.channel?.id !== channel.id) return false;

        await member.voice.setChannel(wrChannel, 'TempVoice waiting room').catch(() => {});
        logger.info(`TempVoice: moved ${member.id} to waiting room for channel ${channel.id}`);
        return true;
    } catch (error) {
        logger.warn(`TempVoice enforceWaitingRoom failed: ${error.message}`);
        return false;
    }
}
