// scheduledLeaderboard.js — automatic biweekly level leaderboard.
//
// Every 2 weeks the bot posts ONE embed with two boards into a configured
// channel:
//   - "Last 2 Weeks — Top 15"  (period XP, resets to 0 each period)
//   - "All Time — Top 5"        (cumulative, mirrors /leaderboard)
//
// Scheduling: an hourly cron tick compares Date.now() against the persisted
// `nextRunAt`. The timestamp survives restarts, so a missed run is posted
// late (catch-up) instead of skipped. Period state lives in the leveling
// config; per-user period XP lives in KV keys (see periodTracker.js).
// No new tables, no new dependencies.

import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLevelingConfig, saveLevelingConfig, getLeaderboard, getXpForLevel } from './leveling.js';
import { getPeriodTop, clearPeriod } from './periodTracker.js';

export const SCHEDULED_LB_COLOR = '#95A5A6'; // neutral gray, not flashy
export const PERIOD_DAYS = 14;
const WIB_OFFSET_MS = 7 * 3600 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function defaultSchedSettings() {
    return {
        enabled: false,
        channelId: null, // null -> fall back to the level-up channel
        day: 0, // Sunday
        hour: 20,
        minute: 0,
        mentionTop3: true,
        periodId: null,
        periodStart: null,
        nextRunAt: null,
    };
}

export function getSchedSettings(levelingConfig) {
    return { ...defaultSchedSettings(), ...(levelingConfig?.scheduledLeaderboard || {}) };
}

function wibDate(ts) {
    return new Date(ts + WIB_OFFSET_MS);
}

export function formatWibDate(ts) {
    const d = wibDate(ts);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function wibDateId(ts) {
    const d = wibDate(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Next occurrence of (day, hour, minute) in WIB, strictly after `from`.
 * day: 0=Sunday..6=Saturday.
 */
export function nextWeekdayOccurrence(day, hour, minute, from = Date.now()) {
    const now = wibDate(from);
    const target = new Date(now.getTime());
    target.setUTCHours(hour, minute, 0, 0);
    let delta = (day - now.getUTCDay() + 7) % 7;
    if (delta === 0 && target.getTime() <= now.getTime()) delta = 7;
    target.setUTCDate(target.getUTCDate() + delta);
    return target.getTime() - WIB_OFFSET_MS;
}

export function describeSchedule(sched) {
    const dayName = DAY_NAMES[sched.day] ?? '?';
    const hh = String(sched.hour).padStart(2, '0');
    const mm = String(sched.minute).padStart(2, '0');
    return `Every 2 weeks · ${dayName} ${hh}:${mm} WIB`;
}

const fmtNum = (n) => Number(n || 0).toLocaleString('id-ID');

// NOTE: src/utils/embeds.js monkey-patches EmbedBuilder globally — emojis are
// stripped from titles/descriptions/fields, decorative footers are dropped,
// and setTimestamp() is a no-op. This embed is designed for that reality:
// bold rank numbers instead of medal emojis, no footer, period info in the
// description. (The existing /leaderboard renders the same way.)
function rankPrefix(index) {
    return `**${index + 1}.**`;
}

async function resolveMemberLabel(guild, userId, { mention }) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (mention) return `<@${userId}>`;
    return member ? member.displayName.replace(/[*_`~]/g, '') : `User ${userId.slice(-4)}`;
}

/**
 * Build the biweekly embed. periodTop: [{ userId, xp }], allTimeTop: rows
 * from getLeaderboard().
 */
export async function buildScheduledLeaderboardEmbed(guild, { periodTop, allTimeTop, periodStart, periodEnd, mentionTop3 }) {
    const periodLines = [];
    for (let i = 0; i < periodTop.length; i++) {
        const entry = periodTop[i];
        const label = await resolveMemberLabel(guild, entry.userId, { mention: mentionTop3 && i < 3 });
        periodLines.push(`${rankPrefix(i)} ${label} — ${fmtNum(entry.xp)} XP`);
    }

    const allTimeLines = [];
    for (let i = 0; i < allTimeTop.length; i++) {
        const u = allTimeTop[i];
        const member = await guild.members.fetch(u.userId).catch(() => null);
        const label = member ? member.user.toString() : `<@${u.userId}>`;
        const xpForNext = getXpForLevel(u.level + 1);
        allTimeLines.push(`${rankPrefix(i)} ${label} - Level ${u.level} (${fmtNum(u.xp)}/${fmtNum(xpForNext)} XP)`);
    }

    const embed = new EmbedBuilder()
        .setTitle('Level Leaderboard')
        .setColor(SCHEDULED_LB_COLOR)
        .setDescription(
            `Top members for **${formatWibDate(periodStart)} – ${formatWibDate(periodEnd)}**\n` +
            `Next update <t:${Math.floor(periodEnd / 1000)}:F>`
        )
        .addFields(
            {
                name: 'Last 2 Weeks — Top 15',
                value: periodLines.length > 0 ? periodLines.join('\n') : '_No activity this period — be the first!_',
            },
            {
                name: 'All Time — Top 5',
                value: allTimeLines.length > 0 ? allTimeLines.join('\n') : '_No level data yet._',
            }
        );

    return embed;
}

async function resolvePostChannel(client, guild, levelingConfig, sched) {
    const channelId = sched.channelId || levelingConfig.levelUpChannel;
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) return null;
    const me = guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) {
        return null;
    }
    return channel;
}

/**
 * Post the scheduled leaderboard now.
 * @param {boolean} rotate — when true (the cron path), the period resets and
 *   the next run is scheduled. The dashboard "Send now" uses rotate=false
 *   so testing never wipes the running period.
 */
export async function postScheduledLeaderboard(client, guild, { rotate = true } = {}) {
    const guildId = guild.id;
    const levelingConfig = await getLevelingConfig(client, guildId);
    if (!levelingConfig?.enabled) {
        return { posted: false, reason: 'leveling disabled' };
    }

    const sched = getSchedSettings(levelingConfig);
    if (!sched.enabled) {
        return { posted: false, reason: 'scheduler disabled' };
    }

    // Make sure a period exists (first run after enabling).
    let periodId = sched.periodId;
    let periodStart = sched.periodStart;
    if (!periodId || !periodStart) {
        periodStart = Date.now();
        periodId = wibDateId(periodStart);
    }

    const channel = await resolvePostChannel(client, guild, levelingConfig, sched);
    if (!channel) {
        logger.warn(`Scheduled leaderboard: no usable channel in guild ${guildId} (set one in /leaderboard-schedule)`);
        return { posted: false, reason: 'no channel' };
    }

    const periodEnd = periodStart + PERIOD_DAYS * 24 * 3600 * 1000;
    const [periodTop, allTimeTop] = await Promise.all([
        getPeriodTop(client, guildId, periodId, 15),
        getLeaderboard(client, guildId, 5),
    ]);

    const embed = await buildScheduledLeaderboardEmbed(guild, {
        periodTop,
        allTimeTop,
        periodStart,
        periodEnd,
        mentionTop3: sched.mentionTop3 !== false,
    });

    await channel.send({ embeds: [embed] });
    logger.info(`Scheduled leaderboard posted in guild ${guildId} (#${channel.name}): ${periodTop.length} period entries`);

    if (rotate) {
        await clearPeriod(client, guildId, periodId);
        const now = Date.now();
        levelingConfig.scheduledLeaderboard = {
            ...sched,
            periodId: wibDateId(now),
            periodStart: now,
            nextRunAt: now + PERIOD_DAYS * 24 * 3600 * 1000,
        };
        await saveLevelingConfig(client, guildId, levelingConfig);
    }

    return { posted: true, periodEntries: periodTop.length };
}

/**
 * Hourly cron entry: post in every guild whose schedule is due.
 * A missed run (bot was down) posts late instead of being skipped.
 */
export async function checkScheduledLeaderboards(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const levelingConfig = await getLevelingConfig(client, guild.id);
            if (!levelingConfig?.enabled) continue;
            const sched = getSchedSettings(levelingConfig);
            if (!sched.enabled) continue;

            if (!sched.nextRunAt) {
                // Scheduled but never initialized (e.g. just enabled) — arm it.
                const now = Date.now();
                levelingConfig.scheduledLeaderboard = {
                    ...sched,
                    periodId: sched.periodId || wibDateId(now),
                    periodStart: sched.periodStart || now,
                    nextRunAt: nextWeekdayOccurrence(sched.day, sched.hour, sched.minute, now),
                };
                await saveLevelingConfig(client, guild.id, levelingConfig);
                logger.info(
                    `Scheduled leaderboard armed in guild ${guild.id}, first run <t:${Math.floor(levelingConfig.scheduledLeaderboard.nextRunAt / 1000)}:F>`
                );
                continue;
            }

            if (Date.now() >= sched.nextRunAt) {
                await postScheduledLeaderboard(client, guild, { rotate: true });
            }
        } catch (error) {
            logger.warn(`Scheduled leaderboard check failed in guild ${guild.id}: ${error.message}`);
        }
    }
}
