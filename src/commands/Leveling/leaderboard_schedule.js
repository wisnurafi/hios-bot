import { getColor } from '../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    LabelBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
    SlashCommandBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { HiosBotError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { getLevelingConfig, saveLevelingConfig } from '../../services/leveling/leveling.js';
import {
    getSchedSettings,
    nextWeekdayOccurrence,
    describeSchedule,
    formatWibDate,
    wibDateId,
    postScheduledLeaderboard,
    PERIOD_DAYS,
} from '../../services/leveling/scheduledLeaderboard.js';
import { botHasPermission } from '../../utils/permissionGuard.js';
import { startDashboardSession } from '../../utils/dashboardSession.js';

const DAY_OPTIONS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function buildDashboardEmbed(cfg, sched, guild) {
    const channelValue = sched.channelId
        ? `<#${sched.channelId}>`
        : cfg.levelUpChannel
            ? `<#${cfg.levelUpChannel}> \`level-up channel\``
            : '`Not set`';

    const nextRun = sched.nextRunAt
        ? `<t:${Math.floor(sched.nextRunAt / 1000)}:F>`
        : '`Not scheduled`';

    const periodValue = sched.periodStart
        ? `${formatWibDate(sched.periodStart)} – ${formatWibDate(sched.periodStart + PERIOD_DAYS * 24 * 3600 * 1000)}`
        : '`Not started`';

    return new EmbedBuilder()
        .setTitle('📊 Scheduled Leaderboard')
        .setDescription(
            'Auto-posts the biweekly leaderboard (Top 15 of the period + All Time Top 5) ' +
            `every 2 weeks.\nSelect an option below to configure it for **${guild.name}**.`
        )
        .setColor(getColor('info'))
        .addFields(
            { name: 'Status', value: sched.enabled ? '**Enabled**' : '**Disabled**', inline: true },
            { name: 'Channel', value: channelValue, inline: true },
            { name: 'Mention Top 3', value: sched.mentionTop3 !== false ? '**Enabled**' : '**Disabled**', inline: true },
            { name: 'Schedule', value: `\`${describeSchedule(sched)}\``, inline: true },
            { name: 'Next Run', value: nextRun, inline: true },
            { name: 'Current Period', value: periodValue, inline: true },
        )
        .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

function buildSelectMenu(guildId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`lbsched_cfg_${guildId}`)
        .setPlaceholder('Select a setting to configure...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Change Post Channel')
                .setDescription('Channel where the leaderboard is posted (defaults to level-up channel)')
                .setValue('channel')
                .setEmoji('📢'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Day')
                .setDescription('Weekday the leaderboard is posted, every 2 weeks')
                .setValue('day')
                .setEmoji('📅'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Time (WIB)')
                .setDescription('Time of day the leaderboard is posted')
                .setValue('time')
                .setEmoji('⏰'),
        );
}

function buildButtonRow(sched, guildId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`lbsched_toggle_enabled_${guildId}`)
            .setLabel(sched.enabled ? 'Disable' : 'Enable')
            .setStyle(sched.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
            .setEmoji('🔁')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`lbsched_toggle_mention_${guildId}`)
            .setLabel('Mention Top 3')
            .setStyle(sched.mentionTop3 !== false ? ButtonStyle.Success : ButtonStyle.Danger)
            .setEmoji('📣')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`lbsched_send_now_${guildId}`)
            .setLabel('Send Now')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🧪')
            .setDisabled(disabled),
    );
}

async function refreshDashboard(rootInteraction, cfg, sched, guildId) {
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(cfg, sched, rootInteraction.guild)],
        components: [
            buildButtonRow(sched, guildId),
            new ActionRowBuilder().addComponents(buildSelectMenu(guildId)),
        ],
    }).catch(() => {});
}

function armSchedule(sched) {
    const now = Date.now();
    return {
        ...sched,
        periodId: sched.periodId || wibDateId(now),
        periodStart: sched.periodStart || now,
        nextRunAt: nextWeekdayOccurrence(sched.day, sched.hour, sched.minute, now),
    };
}

export default {
    data: new SlashCommandBuilder()
        .setName('leaderboard-schedule')
        .setDescription('Configure the automatic biweekly level leaderboard')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),
    category: 'Leveling',

    async execute(interaction, config, client) {
        try {
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.PERMISSION,
                    message: 'You need the **Manage Server** permission to use this command.',
                });
            }

            const guildId = interaction.guild.id;
            const cfg = await getLevelingConfig(client, guildId);

            if (!cfg.configured) {
                throw new HiosBotError(
                    'Leveling system not configured',
                    ErrorTypes.CONFIGURATION,
                    'The leveling system has not been set up yet. Run `/level setup` first.',
                );
            }

            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

            let sched = getSchedSettings(cfg);

            await startDashboardSession({
                interaction,
                flags: MessageFlags.Ephemeral,
                embeds: [buildDashboardEmbed(cfg, sched, interaction.guild)],
                components: [
                    buildButtonRow(sched, guildId),
                    new ActionRowBuilder().addComponents(buildSelectMenu(guildId)),
                ],
                selectMenuId: `lbsched_cfg_${guildId}`,
                buttonMatcher: (customId) =>
                    customId === `lbsched_toggle_enabled_${guildId}` ||
                    customId === `lbsched_toggle_mention_${guildId}` ||
                    customId === `lbsched_send_now_${guildId}`,
                onSelect: async (selectInteraction) => {
                    const value = selectInteraction.values[0];
                    if (value === 'channel') {
                        await handleChannel(selectInteraction, interaction, cfg, guildId, client);
                    } else if (value === 'day') {
                        await handleDay(selectInteraction, interaction, cfg, guildId, client);
                    } else if (value === 'time') {
                        await handleTime(selectInteraction, interaction, cfg, guildId, client);
                    }
                },
                onButton: async (btnInteraction) => {
                    await btnInteraction.deferUpdate().catch(() => null);
                    const customId = btnInteraction.customId;
                    const freshCfg = await getLevelingConfig(client, guildId);
                    let schedNow = getSchedSettings(freshCfg);

                    if (customId === `lbsched_send_now_${guildId}`) {
                        try {
                            const result = await postScheduledLeaderboard(client, btnInteraction.guild, { rotate: false });
                            await btnInteraction.followUp({
                                embeds: [
                                    result.posted
                                        ? successEmbed('✅ Leaderboard Sent', `Test post sent with **${result.periodEntries}** period entries. The running period was not reset.`)
                                        : errorEmbed('❌ Send Failed', `Could not post: ${result.reason}. Check the channel setting and bot permissions.`),
                                ],
                                flags: MessageFlags.Ephemeral,
                            });
                        } catch (error) {
                            logger.error(`Scheduled leaderboard test send failed: ${error.message}`);
                            await btnInteraction.followUp({
                                embeds: [errorEmbed('❌ Send Failed', 'Could not post the leaderboard. Check the channel and bot permissions.')],
                                flags: MessageFlags.Ephemeral,
                            });
                        }
                        return;
                    }

                    if (customId === `lbsched_toggle_enabled_${guildId}`) {
                        schedNow = { ...schedNow, enabled: !schedNow.enabled };
                        if (schedNow.enabled) {
                            schedNow = armSchedule(schedNow);
                        }
                        freshCfg.scheduledLeaderboard = schedNow;
                        await saveLevelingConfig(client, guildId, freshCfg);

                        const channelOk = schedNow.channelId || cfg.levelUpChannel;
                        await btnInteraction.followUp({
                            embeds: [
                                successEmbed(
                                    '✅ Scheduler Updated',
                                    schedNow.enabled
                                        ? `Auto-post **enabled**. First run <t:${Math.floor(schedNow.nextRunAt / 1000)}:F>.` +
                                          (channelOk ? '' : '\n> ⚠️ No post channel set — posts will be skipped until you set one (or set a level-up channel).')
                                        : 'Auto-post **disabled**. Period tracking is paused; the current period data is kept.',
                                ),
                            ],
                            flags: MessageFlags.Ephemeral,
                        });
                    } else {
                        schedNow = { ...schedNow, mentionTop3: !(schedNow.mentionTop3 !== false) };
                        freshCfg.scheduledLeaderboard = schedNow;
                        await saveLevelingConfig(client, guildId, freshCfg);
                        await btnInteraction.followUp({
                            embeds: [
                                successEmbed(
                                    '✅ Updated',
                                    `Top-3 mentions are now **${schedNow.mentionTop3 ? 'enabled' : 'disabled'}**.`,
                                ),
                            ],
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    const updatedCfg = await getLevelingConfig(client, guildId);
                    await refreshDashboard(interaction, updatedCfg, getSchedSettings(updatedCfg), guildId);
                },
            });
        } catch (error) {
            if (error instanceof HiosBotError) throw error;
            logger.error('Unexpected error in leaderboard-schedule:', error);
            throw new HiosBotError(
                `Leaderboard schedule failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the scheduled leaderboard dashboard.',
            );
        }
    },
};

async function handleChannel(selectInteraction, rootInteraction, cfg, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`lbsched_channel_modal_${guildId}`)
        .setTitle('📢 Post Channel');

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('lbsched_channel')
        .setPlaceholder('Select a text channel...')
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel('Leaderboard Channel')
        .setDescription('Biweekly leaderboard posts go here (empty the setting in /level setup to use default)')
        .setChannelSelectMenuComponent(channelSelect);

    modal.addLabelComponents(channelLabel);
    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: (i) => i.customId === `lbsched_channel_modal_${guildId}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);
    if (!submitted) return;

    const channelId = submitted.fields.getField('lbsched_channel').values[0];
    const channel = selectInteraction.guild.channels.cache.get(channelId);

    if (channel && !botHasPermission(channel, ['SendMessages', 'EmbedLinks'])) {
        await replyUserError(submitted, {
            type: ErrorTypes.PERMISSION,
            message: `I need **SendMessages** and **EmbedLinks** permissions in ${channel} to post the leaderboard.`,
        });
        return;
    }

    const sched = getSchedSettings(cfg);
    cfg.scheduledLeaderboard = { ...sched, channelId };
    await saveLevelingConfig(client, guildId, cfg);

    await submitted.reply({
        embeds: [successEmbed('✅ Channel Updated', `The biweekly leaderboard will be posted in ${channel ?? `<#${channelId}>`}.`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, getSchedSettings(cfg), guildId);
}

async function handleDay(selectInteraction, rootInteraction, cfg, guildId, client) {
    const sched = getSchedSettings(cfg);

    const daySelect = new StringSelectMenuBuilder()
        .setCustomId(`lbsched_day_pick_${guildId}`)
        .setPlaceholder('Select a weekday...')
        .addOptions(
            DAY_OPTIONS.map((name, idx) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(name)
                    .setValue(String(idx))
                    .setDefault(idx === sched.day)
            )
        );

    const dayMsg = await selectInteraction.reply({
        content: 'Pick the weekday the leaderboard is posted (every 2 weeks):',
        components: [new ActionRowBuilder().addComponents(daySelect)],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
    });

    // NOTE: awaitMessageComponent only exists on Message, not on interactions.
    const picked = await dayMsg
        .awaitMessageComponent({
            filter: (i) => i.customId === `lbsched_day_pick_${guildId}` && i.user.id === selectInteraction.user.id,
            componentType: ComponentType.StringSelect,
            time: 60_000,
        })
        .catch(() => null);
    if (!picked) return;

    const day = Number(picked.values[0]);
    const updated = { ...getSchedSettings(cfg), day };
    const rearmed = { ...updated, nextRunAt: nextWeekdayOccurrence(day, updated.hour, updated.minute) };
    cfg.scheduledLeaderboard = rearmed;
    await saveLevelingConfig(client, guildId, cfg);

    await picked.update({
        content: `Weekday set to **${DAY_OPTIONS[day]}**. Next run <t:${Math.floor(rearmed.nextRunAt / 1000)}:F>.`,
        components: [],
    });

    await refreshDashboard(rootInteraction, cfg, getSchedSettings(cfg), guildId);
}

async function handleTime(selectInteraction, rootInteraction, cfg, guildId, client) {
    const sched = getSchedSettings(cfg);

    const modal = new ModalBuilder()
        .setCustomId(`lbsched_time_modal_${guildId}`)
        .setTitle('⏰ Post Time (WIB)')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('hour_input')
                    .setLabel('Hour (0–23, WIB)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(sched.hour))
                    .setMaxLength(2)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('20'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('minute_input')
                    .setLabel('Minute (0–59)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(sched.minute).padStart(2, '0'))
                    .setMaxLength(2)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('00'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: (i) => i.customId === `lbsched_time_modal_${guildId}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);
    if (!submitted) return;

    const hour = Number.parseInt(submitted.fields.getTextInputValue('hour_input').trim(), 10);
    const minute = Number.parseInt(submitted.fields.getTextInputValue('minute_input').trim(), 10);

    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: 'Time must be a valid WIB time: hour **0–23**, minute **0–59**.',
        });
        return;
    }

    const updated = { ...getSchedSettings(cfg), hour, minute };
    const rearmed = { ...updated, nextRunAt: nextWeekdayOccurrence(updated.day, hour, minute) };
    cfg.scheduledLeaderboard = rearmed;
    await saveLevelingConfig(client, guildId, cfg);

    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    await submitted.reply({
        embeds: [successEmbed('✅ Time Updated', `Leaderboard posts at **${hh}:${mm} WIB**. Next run <t:${Math.floor(rearmed.nextRunAt / 1000)}:F>.`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, cfg, getSchedSettings(cfg), guildId);
}
