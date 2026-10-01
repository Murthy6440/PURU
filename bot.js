const http = require('http');

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Purnima Gaming Bot is running');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Web server running on port ${PORT}`);
});
require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  EmbedBuilder, ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

// ───────────────────────── Settings ─────────────────────────
const BRAND = 'Purnima Gaming';
const FOOTER_TEXT = 'Purnima Gaming • Discord Bot';
const COLORS = { main: 0x7c3aed, ok: 0x22c55e, warn: 0xf59e0b, red: 0xef4444, yt: 0xff0000, kick: 0x53fc18 };
const AUTO_MUTE_AT = 3;                 // auto-timeout when a user reaches this many warnings
const AUTO_MUTE_MS = 60 * 60 * 1000;    // 1 hour
const KICK_POLL_INTERVAL_MS = 30 * 1000;
const YOUTUBE_POLL_INTERVAL_MS = 30 * 1000;
const POLL_MS = KICK_POLL_INTERVAL_MS; // compatibility with the existing polling logic
const LOG_FEATURES = [
  { name: 'Moderation', value: 'moderation' },
  { name: 'YouTube announcements', value: 'youtube' },
  { name: 'Kick announcements', value: 'kick' },
  { name: 'Anti-Ping', value: 'antiping' },
  { name: 'Bot config', value: 'config' },
];

// ───────────────────────── Storage (data.json) ─────────────────────────
const DB_FILE = './data.json';
let db = { guilds: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('DB load failed', e); }
const save = () => { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); };
const cfg = (gid) => (db.guilds[gid] ??= {
  modRoles: [],
  logs: {},                                   // feature -> channelId
  announce: { youtube: null, kick: null },    // { channel, role }
  youtube: [],                                // { id, name, last }
  kick: [],                                   // { slug, live }
  antiping: { enabled: true, users: [], autoWarn: true },
  warnings: {},                               // userId -> [{ reason, mod, at }]
});

// ───────────────────────── Client ─────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const makeEmbed = ({ title = null, description = '', color = COLORS.main, fields = [] } = {}) => {
  const e = new EmbedBuilder().setColor(color).setTimestamp().setFooter({ text: FOOTER_TEXT });
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  if (fields.length) e.addFields(fields);
  return e;
};

const embed = (title, desc, color = COLORS.main, fields = []) => makeEmbed({ title, description: desc, color, fields });
const successEmbed = (title, description, fields = []) => makeEmbed({ title: `✅ ${title}`, description, color: COLORS.ok, fields });
const errorEmbed = (title, description, fields = []) => makeEmbed({ title: `❌ ${title}`, description, color: COLORS.red, fields });
const warningEmbed = (title, description, fields = []) => makeEmbed({ title: `⚠️ ${title}`, description, color: COLORS.warn, fields });
const infoEmbed = (title, description, fields = []) => makeEmbed({ title: `ℹ️ ${title}`, description, color: COLORS.main, fields });
const configEmbed = (title, description, fields = []) => makeEmbed({ title: `⚙️ ${title}`, description, color: COLORS.main, fields });
const moderationEmbed = (title, description, fields = []) => makeEmbed({ title: `🛡️ ${title}`, description, color: COLORS.main, fields });

const isAdmin = (m) => m.permissions.has(PermissionFlagsBits.Administrator) || m.permissions.has(PermissionFlagsBits.ManageGuild);
const isMod = (m) => isAdmin(m) || cfg(m.guild.id).modRoles.some((r) => m.roles.cache.has(r));

async function sendTo(guild, channelId, payload) {
  if (!channelId) return null;
  const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  return ch?.send(payload).catch((e) => console.error('send failed', e.message)) ?? null;
}
const log = (guild, feature, e) => sendTo(guild, cfg(guild.id).logs[feature], { embeds: [e] });
const dm = (user, e) => user.send({ embeds: [e] }).catch(() => {});

function parseDuration(s) {
  const m = /^(\d+)\s*([smhd])$/i.exec(s.trim());
  if (!m) return null;
  const ms = Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  return ms > 0 && ms <= 28 * 864e5 ? ms : null; // Discord max timeout = 28 days
}
const fmtMs = (ms) => {
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && !h && !m && `${s}s`].filter(Boolean).join(' ');
};

function hierarchyCheck(i, member, action) {
  if (!member) return null;
  if (member.id === i.user.id) return "You can't do that to yourself.";
  if (member.id === client.user.id) return "Nice try.";
  if (member.id === i.guild.ownerId) return "You can't target the server owner.";
  if (i.user.id !== i.guild.ownerId && i.member.roles.highest.position <= member.roles.highest.position)
    return "That member's top role is equal to or higher than yours.";
  const ok = { mute: member.moderatable, kick: member.kickable, ban: member.bannable }[action];
  if (ok === false) return "My role is too low to do that. Move my role above theirs.";
  return null;
}

async function addWarning(guild, user, modId, reason) {
  const list = (cfg(guild.id).warnings[user.id] ??= []);
  list.push({ reason, mod: modId, at: Date.now() });
  save();
  let auto = false;
  if (list.length >= AUTO_MUTE_AT) {
    const m = await guild.members.fetch(user.id).catch(() => null);
    if (m?.moderatable) { await m.timeout(AUTO_MUTE_MS, `Auto-mute: ${list.length} warnings`).catch(() => {}); auto = true; }
  }
  return { count: list.length, auto };
}

// ───────────────────────── Commands ─────────────────────────
const modPerm = PermissionFlagsBits.ModerateMembers;
const reasonOpt = (o) => o.setName('reason').setDescription('Reason');
const userOpt = (o) => o.setName('user').setDescription('Target user').setRequired(true);

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('View bot commands and categories'),
  new SlashCommandBuilder().setName('rechecklive').setDescription('Immediately re-check all configured live channels'),
  new SlashCommandBuilder().setName('streamcheck').setDescription('Check all configured streams immediately'),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
    .addUserOption(userOpt).addStringOption((o) => reasonOpt(o).setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('View a member\'s warnings').addUserOption(userOpt),
  new SlashCommandBuilder().setName('clearwarnings').setDescription('Clear all warnings of a member').addUserOption(userOpt),
  new SlashCommandBuilder().setName('mute').setDescription('Timeout a member')
    .addUserOption(userOpt)
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 2h, 1d (max 28d)').setRequired(true))
    .addStringOption(reasonOpt),
  new SlashCommandBuilder().setName('unmute').setDescription('Remove a timeout').addUserOption(userOpt).addStringOption(reasonOpt),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member').addUserOption(userOpt).addStringOption(reasonOpt),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a user')
    .addUserOption(userOpt).addStringOption(reasonOpt)
    .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7)),
  new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID')
    .addStringOption((o) => o.setName('user_id').setDescription('User ID').setRequired(true)).addStringOption(reasonOpt),

  new SlashCommandBuilder().setName('setlogs').setDescription('Set (or disable) the log channel for a feature')
    .addStringOption((o) => o.setName('feature').setDescription('Feature').setRequired(true).addChoices(...LOG_FEATURES))
    .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to disable').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  new SlashCommandBuilder().setName('setannounce').setDescription('Set the announcement channel for a platform')
    .addStringOption((o) => o.setName('platform').setDescription('Platform').setRequired(true).addChoices({ name: 'YouTube', value: 'youtube' }, { name: 'Kick', value: 'kick' }))
    .addChannelOption((o) => o.setName('channel').setDescription('Announcement channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping (optional)')),

  new SlashCommandBuilder().setName('youtube').setDescription('Manage YouTube channels to announce')
    .addSubcommand((s) => s.setName('add').setDescription('Track a channel').addStringOption((o) => o.setName('channel').setDescription('Channel ID (UC...), channel URL or @handle').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Stop tracking').addStringOption((o) => o.setName('channel').setDescription('Channel ID or name').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List tracked channels')),
  new SlashCommandBuilder().setName('kicklive').setDescription('Manage Kick streamers to announce')
    .addSubcommand((s) => s.setName('add').setDescription('Track a streamer').addStringOption((o) => o.setName('username').setDescription('Kick username').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Stop tracking').addStringOption((o) => o.setName('username').setDescription('Kick username').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List tracked streamers')),

  new SlashCommandBuilder().setName('antiping').setDescription('Protect specific users from being pinged')
    .addSubcommand((s) => s.setName('add').setDescription('Protect a user').addUserOption(userOpt))
    .addSubcommand((s) => s.setName('remove').setDescription('Unprotect a user').addUserOption(userOpt))
    .addSubcommand((s) => s.setName('list').setDescription('Show protected users'))
    .addSubcommand((s) => s.setName('toggle').setDescription('Turn anti-ping on/off')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enabled?').setRequired(true))
      .addBooleanOption((o) => o.setName('autowarn').setDescription('Warn people who ping protected users?'))),

  new SlashCommandBuilder().setName('modrole').setDescription('Choose which roles count as moderators (Admin only)')
    .addSubcommand((s) => s.setName('add').setDescription('Add a mod role').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a mod role').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List mod roles')),
].map((c) => c.setDefaultMemberPermissions(c.name === 'streamcheck' ? PermissionFlagsBits.Administrator : modPerm).setDMPermission(false).toJSON());

// ───────────────────────── Handlers ─────────────────────────
const H = {
  async help(i) {
    const sections = [
      { name: '🛡️ MODERATION', value: '/warn\n/warnings\n/mute\n/kick\n/ban\n/unban', inline: false },
      { name: '⚙️ CONFIGURATION', value: '/setlogs\n/setannounce\n/antiping\n/modrole', inline: false },
      { name: '📺 YOUTUBE', value: '/youtube add\n/youtube remove\n/youtube list', inline: false },
      { name: '🟢 KICK', value: '/kicklive add\n/kicklive remove\n/kicklive list', inline: false },
      { name: '🔧 UTILITY', value: '/help\n/rechecklive\n/streamcheck', inline: false },
    ];

    const e = new EmbedBuilder()
      .setTitle('PURNIMA GAMING BOT')
      .setDescription('Professional moderation and live announcement management for your community.')
      .setColor(COLORS.main)
      .addFields(sections)
      .setTimestamp()
      .setFooter({ text: FOOTER_TEXT });

    return i.reply({ embeds: [e] });
  },

  async rechecklive(i) {
    await i.deferReply();
    const guild = i.guild;
    const c = cfg(guild.id);
    const found = { youtube: [], kick: [] };

    try {
      for (const y of c.youtube) {
        const info = await checkYouTubeChannel(guild, y, { announceOnlyLive: true });
        if (info.sent && info.value) found.youtube.push(info.value);
      }

      for (const k of c.kick) {
        const info = await checkKickChannel(guild, k, { announceOnlyLive: true });
        if (info.sent && info.value) found.kick.push(info.value);
      }

      if (!found.youtube.length && !found.kick.length) {
        return i.editReply({ embeds: [infoEmbed('🔎 LIVE RECHECK COMPLETE', 'No configured YouTube or Kick channels are currently live.')] });
      }

      const fields = [];
      if (found.youtube.length) fields.push({ name: 'YouTube', value: found.youtube.map((name) => `• ${name}`).join('\n'), inline: false });
      if (found.kick.length) fields.push({ name: 'Kick', value: found.kick.map((name) => `• ${name}`).join('\n'), inline: false });

      const e = infoEmbed('🔴 LIVE CHANNELS FOUND', 'Announcements have been sent.', fields);
      return i.editReply({ embeds: [e] });
    } catch (error) {
      console.error('Manual live recheck failed:', error);
      return i.editReply({ embeds: [errorEmbed('LIVE RECHECK FAILED', 'The live check could not be completed right now. Please try again in a moment.')] });
    }
  },

  async streamcheck(i) {
    await i.deferReply();
    try {
      if (typeof pollKickStreams === 'function') await pollKickStreams();
      if (typeof pollYoutubeChannels === 'function') await pollYoutubeChannels();

      const guild = i.guild;
      const c = cfg(guild.id);
      const kickLines = c.kick.length ? c.kick.map((k) => `${k.live ? '🟢' : '⚫'} ${k.slug} — ${k.live ? 'LIVE' : 'OFFLINE'}`).join('\n') : '⚫ No Kick channels tracked';
      const youtubeLines = c.youtube.length ? c.youtube.map((y) => `${y.live ? '🔴' : '⚫'} ${y.name || y.id} — ${y.live ? 'LIVE' : 'OFFLINE'}`).join('\n') : '⚫ No YouTube channels tracked';

      const e = infoEmbed('🔎 STREAM CHECK COMPLETE', `Last checked: <t:${Math.floor(Date.now() / 1000)}:F>`, [
        { name: 'Kick', value: kickLines, inline: false },
        { name: 'YouTube', value: youtubeLines, inline: false },
      ]);
      return i.editReply({ embeds: [e] });
    } catch (error) {
      console.error('Stream check failed:', error);
      return i.editReply({ embeds: [errorEmbed('STREAM CHECK FAILED', 'The stream status check could not be completed right now. Please try again in a moment.')] });
    }
  },

  async warn(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), reason = i.options.getString('reason');
    const member = i.options.getMember('user');
    const err = hierarchyCheck(i, member, 'warn');
    if (err) return i.editReply({ embeds: [warningEmbed('ACTION BLOCKED', err)] });
    const { count, auto } = await addWarning(i.guild, user, i.user.id, reason);
    const e = moderationEmbed('MEMBER WARNED', '', [
      { name: 'Member', value: `${user} (${user.id})`, inline: true },
      { name: 'Moderator', value: `${i.user}`, inline: true },
      { name: 'Reason', value: reason, inline: false },
      { name: 'Warnings', value: `${count}${auto ? `\nAuto-mute: 1h after ${AUTO_MUTE_AT} warnings` : ''}`, inline: false },
    ]);
    await dm(user, embed(`You were warned in ${i.guild.name}`, `**Reason:** ${reason}\n**Warnings:** ${count}`, COLORS.warn));
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }));
  },

  async warnings(i) {
    const user = i.options.getUser('user');
    const list = cfg(i.guildId).warnings[user.id] ?? [];
    if (!list.length) {
      return i.reply({ embeds: [infoEmbed('📭 NO WARNINGS FOUND', `${user} has no recorded warnings yet.`)] });
    }
    const body = list.slice(-10).map((w, n) => `**${list.length - Math.min(10, list.length) + n + 1}.** ${w.reason}\n<t:${Math.floor(w.at / 1000)}:R> by <@${w.mod}>`).join('\n\n');
    return i.reply({ embeds: [warningEmbed('WARNINGS LIST', `Member: ${user} (${user.id})`, [{ name: 'Recent cases', value: body, inline: false }])] });
  },

  async clearwarnings(i) {
    const user = i.options.getUser('user');
    const c = cfg(i.guildId);
    const n = (c.warnings[user.id] ?? []).length;
    delete c.warnings[user.id]; save();
    const e = successEmbed('WARNINGS CLEARED', `Removed **${n}** warning(s) from ${user}.`, [{ name: 'Moderator', value: `${i.user}`, inline: true }]);
    await i.reply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }));
  },

  async mute(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const ms = parseDuration(i.options.getString('duration'));
    const reason = i.options.getString('reason') ?? 'No reason provided';
    if (!member) return i.editReply({ embeds: [errorEmbed('INVALID MEMBER', 'That user is not in the server.')] });
    if (!ms) return i.editReply({ embeds: [errorEmbed('INVALID DURATION', 'Use formats like `10m`, `2h`, `1d` (max 28d).')] });
    const err = hierarchyCheck(i, member, 'mute');
    if (err) return i.editReply({ embeds: [warningEmbed('ACTION BLOCKED', err)] });
    await member.timeout(ms, `${reason} | by ${i.user.tag}`);
    const e = moderationEmbed('MEMBER MUTED', '', [
      { name: 'Member', value: `${user} (${user.id})`, inline: true },
      { name: 'Moderator', value: `${i.user}`, inline: true },
      { name: 'Duration', value: fmtMs(ms), inline: true },
      { name: 'Reason', value: reason, inline: false },
    ]);
    await dm(user, embed(`You were muted in ${i.guild.name}`, `**Duration:** ${fmtMs(ms)}\n**Reason:** ${reason}`, COLORS.warn));
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }));
  },

  async unmute(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const reason = i.options.getString('reason') ?? 'No reason provided';
    if (!member) return i.editReply({ embeds: [errorEmbed('INVALID MEMBER', 'That user is not in the server.')] });
    await member.timeout(null, `${reason} | by ${i.user.tag}`);
    const e = successEmbed('MEMBER UNMUTED', '', [
      { name: 'Member', value: `${user} (${user.id})`, inline: true },
      { name: 'Moderator', value: `${i.user}`, inline: true },
      { name: 'Reason', value: reason, inline: false },
    ]);
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }));
  },

  async kick(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const reason = i.options.getString('reason') ?? 'No reason provided';
    if (!member) return i.editReply({ embeds: [errorEmbed('INVALID MEMBER', 'That user is not in the server.')] });
    const err = hierarchyCheck(i, member, 'kick');
    if (err) return i.editReply({ embeds: [warningEmbed('ACTION BLOCKED', err)] });
    await dm(user, embed(`You were kicked from ${i.guild.name}`, `**Reason:** ${reason}`, COLORS.red));
    await member.kick(`${reason} | by ${i.user.tag}`);
    const e = moderationEmbed('MEMBER KICKED', '', [
      { name: 'Member', value: `${user} (${user.id})`, inline: true },
      { name: 'Moderator', value: `${i.user}`, inline: true },
      { name: 'Reason', value: reason, inline: false },
    ]);
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }));
  },

  async ban(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const reason = i.options.getString('reason') ?? 'No reason provided';
    const days = i.options.getInteger('delete_days') ?? 0;
    const err = hierarchyCheck(i, member, 'ban');
    if (err) return i.editReply({ embeds: [warningEmbed('ACTION BLOCKED', err)] });
    if (member) await dm(user, embed(`You were banned from ${i.guild.name}`, `**Reason:** ${reason}`, COLORS.red));
    await i.guild.members.ban(user.id, { reason: `${reason} | by ${i.user.tag}`, deleteMessageSeconds: days * 86400 });
    const e = moderationEmbed('MEMBER BANNED', '', [
      { name: 'Member', value: `${user} (${user.id})`, inline: true },
      { name: 'Moderator', value: `${i.user}`, inline: true },
      { name: 'Reason', value: reason, inline: false },
    ]);
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }));
  },

  async unban(i) {
    await i.deferReply();
    const id = i.options.getString('user_id').trim();
    const reason = i.options.getString('reason') ?? 'No reason provided';
    await i.guild.members.unban(id, `${reason} | by ${i.user.tag}`).catch(() => null)
      .then(async (r) => {
        if (!r) return i.editReply({ embeds: [errorEmbed('USER NOT FOUND', 'That user is not banned or the ID is invalid.')] });
        const e = successEmbed('USER UNBANNED', '', [
          { name: 'User', value: `<@${id}> (${id})`, inline: true },
          { name: 'Moderator', value: `${i.user}`, inline: true },
          { name: 'Reason', value: reason, inline: false },
        ]);
        await i.editReply({ embeds: [e] });
        log(i.guild, 'moderation', e.addFields({ name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }));
      });
  },

  async setlogs(i) {
    const feature = i.options.getString('feature'), ch = i.options.getChannel('channel');
    const c = cfg(i.guildId);
    if (ch) c.logs[feature] = ch.id; else delete c.logs[feature];
    save();
    const e = configEmbed('CONFIGURATION UPDATED', `Updated the **${feature}** log channel.`, [
      { name: 'Setting', value: 'Log Channel', inline: true },
      { name: 'Feature', value: feature, inline: true },
      { name: 'Channel', value: ch ? `${ch}` : 'Disabled', inline: false },
    ]);
    await i.reply({ embeds: [e] });
    if (ch) log(i.guild, 'config', e.addFields({ name: 'Updated By', value: `${i.user}` }));
  },

  async setannounce(i) {
    const p = i.options.getString('platform'), ch = i.options.getChannel('channel'), role = i.options.getRole('ping_role');
    cfg(i.guildId).announce[p] = { channel: ch.id, role: role?.id ?? null };
    save();
    const e = configEmbed('CONFIGURATION UPDATED', `Updated the **${p}** announcement settings.`, [
      { name: 'Setting', value: 'Announcement Channel', inline: true },
      { name: 'Platform', value: p === 'youtube' ? 'YouTube' : 'Kick', inline: true },
      { name: 'Channel', value: `${ch}`, inline: false },
      { name: 'Role', value: role ? `${role}` : 'None', inline: false },
    ]);
    await i.reply({ embeds: [e] });
    log(i.guild, 'config', e.addFields({ name: 'Updated By', value: `${i.user}` }));
  },

  async youtube(i) {
    const c = cfg(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'list') {
      if (!c.youtube.length) {
        return i.reply({ embeds: [infoEmbed('📭 NO CONFIGURATION FOUND', 'No YouTube channels are currently being monitored.', [{ name: 'Action', value: 'Use /youtube add to add one.' }])] });
      }
      const fields = c.youtube.map((y, idx) => ({
        name: `${idx + 1}. ${y.name}`,
        value: `Status: 🟢 Monitoring\nChannel ID: \`${y.id}\``,
        inline: false,
      }));
      return i.reply({ embeds: [infoEmbed('📺 YOUTUBE CHANNELS', 'Live and upload notifications are currently monitoring these channels.', fields)] });
    }

    const input = i.options.getString('channel')?.trim();

    if (sub === 'remove') {
      const before = c.youtube.length;
      c.youtube = c.youtube.filter((y) => y.id !== input && y.name.toLowerCase() !== input.toLowerCase());
      save();
      return i.reply({ embeds: [before === c.youtube.length ? errorEmbed('CHANNEL NOT FOUND', 'That YouTube channel is not currently being tracked.') : successEmbed('YOUTUBE CHANNEL REMOVED', `Removed **${input}** from monitoring.`)] });
    }

    await i.deferReply();

    try {
      const id = await resolveYouTubeId(input);

      if (!id) {
        return i.editReply({ embeds: [errorEmbed('INVALID CHANNEL', 'Could not find that channel. Use a YouTube channel ID starting with `UC` or a valid @handle.')] });
      }

      if (c.youtube.some((y) => y.id === id)) {
        return i.editReply({ embeds: [warningEmbed('ALREADY TRACKED', 'That channel is already in the list.')] });
      }

      const feed = await fetchYouTubeFeed(id);

      if (!feed) {
        return i.editReply({ embeds: [errorEmbed('YOUTUBE ERROR', 'Could not read that channel right now. Please try again later.')] });
      }

      c.youtube.push({ id, name: feed.author, seen: feed.videos.map((v) => v.id) });
      save();

      const e = successEmbed('YOUTUBE CHANNEL ADDED', `Now tracking **${feed.author}**.`, [
        { name: 'Channel ID', value: id, inline: true },
        { name: 'Notifications', value: 'Enabled', inline: true },
      ]);

      await i.editReply({ embeds: [e] });
      log(i.guild, 'config', e.addFields({ name: 'Updated By', value: `${i.user}` }));
    } catch (error) {
      console.error('YouTube command error:', error);
      if (i.deferred || i.replied) {
        await i.editReply({ embeds: [errorEmbed('YOUTUBE UNAVAILABLE', 'YouTube could not be reached. Please try again in a moment.')] }).catch(() => {});
      }
    }
  },

  async kicklive(i) {
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'list') {
      if (!c.kick.length) {
        return i.reply({ embeds: [infoEmbed('📭 NO CONFIGURATION FOUND', 'No Kick streamers are currently being monitored.', [{ name: 'Action', value: 'Use /kicklive add to add one.' }])] });
      }
      const fields = c.kick.map((k, idx) => ({
        name: `${idx + 1}. ${k.slug}`,
        value: `Status: ${k.live ? '🟢 Live' : '🟡 Offline'}\nMonitoring: Enabled`,
        inline: false,
      }));
      return i.reply({ embeds: [infoEmbed('🟢 KICK STREAMERS', 'Live notifications are currently monitoring these streamers.', fields)] });
    }
    const slug = i.options.getString('username').trim().toLowerCase();
    if (sub === 'remove') {
      const before = c.kick.length;
      c.kick = c.kick.filter((k) => k.slug !== slug); save();
      return i.reply({ embeds: [before === c.kick.length ? errorEmbed('STREAMER NOT FOUND', 'That Kick streamer is not currently being tracked.') : successEmbed('KICK STREAMER REMOVED', `Stopped tracking **${slug}**.`)] });
    }
    if (c.kick.some((k) => k.slug === slug)) return i.reply({ embeds: [warningEmbed('ALREADY TRACKED', 'That streamer is already in the list.')] });
    c.kick.push({ slug, live: false }); save();
    const e = successEmbed('KICK STREAMER ADDED', `Now tracking **${slug}**.`, [{ name: 'Platform', value: 'Kick', inline: true }, { name: 'Notifications', value: 'Enabled', inline: true }]);
    await i.reply({ embeds: [e] });
    log(i.guild, 'config', e.addFields({ name: 'Updated By', value: `${i.user}` }));
  },

  async antiping(i) {
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'list') {
      const t = c.antiping.users.length ? c.antiping.users.map((u) => `• <@${u}>`).join('\n') : 'No protected users.';
      return i.reply({ embeds: [infoEmbed(`ANTI-PING (${c.antiping.enabled ? 'ON' : 'OFF'})`, t)] });
    }
    if (sub === 'toggle') {
      c.antiping.enabled = i.options.getBoolean('enabled');
      const aw = i.options.getBoolean('autowarn');
      if (aw !== null) c.antiping.autoWarn = aw;
      save();
      return i.reply({ embeds: [successEmbed('ANTI-PING UPDATED', '', [{ name: 'Enabled', value: String(c.antiping.enabled), inline: true }, { name: 'Auto-warn', value: String(c.antiping.autoWarn), inline: true }])] });
    }
    const user = i.options.getUser('user');
    if (sub === 'add') { if (!c.antiping.users.includes(user.id)) c.antiping.users.push(user.id); }
    else c.antiping.users = c.antiping.users.filter((u) => u !== user.id);
    save();
    const e = successEmbed('ANTI-PING UPDATED', `${user} ${sub === 'add' ? 'is now protected' : 'is no longer protected'}.`);
    await i.reply({ embeds: [e] });
    log(i.guild, 'antiping', e.addFields({ name: 'Updated By', value: `${i.user}` }));
  },

  async modrole(i) {
    if (!isAdmin(i.member)) return i.reply({ embeds: [errorEmbed('PERMISSION REQUIRED', 'You need:\n**Administrator**\n\nto manage mod roles.')], flags: MessageFlags.Ephemeral });
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'list') return i.reply({ embeds: [infoEmbed('MODERATOR ROLES', c.modRoles.length ? c.modRoles.map((r) => `• <@&${r}>`).join('\n') : 'No configured moderator roles yet. Admins and Manage Server can still act as moderators.')] });
    const role = i.options.getRole('role');
    if (sub === 'add') { if (!c.modRoles.includes(role.id)) c.modRoles.push(role.id); }
    else c.modRoles = c.modRoles.filter((r) => r !== role.id);
    save();
    const e = successEmbed('MODERATOR ROLE UPDATED', `${role} ${sub === 'add' ? 'added' : 'removed'}.`);
    await i.reply({ embeds: [e] });
    log(i.guild, 'config', e.addFields({ name: 'Updated By', value: `${i.user}` }));
  },
};

client.on('interactionCreate', async (i) => {
  if (i.isButton()) {
    if (i.customId.startsWith('kick_status_')) {
      const slug = i.customId.replace('kick_status_', '').trim();
      const tracked = cfg(i.guild.id).kick.find((k) => k.slug === slug);
      if (!tracked) return i.reply({ embeds: [infoEmbed('🔎 KICK STATUS', `${slug} is not being tracked here.`)], flags: MessageFlags.Ephemeral }).catch(() => {});
      try {
        const data = await fetchKick(slug);
        const live = Boolean(data?.live);
        const status = infoEmbed('🔎 KICK STATUS', `${live ? '🟢' : '⚫'} **${slug}** is currently ${live ? 'LIVE' : 'OFFLINE'}.`, [{ name: 'Last checked', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }]);
        return i.reply({ embeds: [status], flags: MessageFlags.Ephemeral }).catch(() => {});
      } catch (error) {
        console.error('Kick status button failed:', error);
        return i.reply({ embeds: [errorEmbed('KICK STATUS ERROR', 'The status check could not be completed right now.')], flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    if (i.customId.startsWith('youtube_status_')) {
      const videoId = i.customId.replace('youtube_status_', '').trim();
      try {
        const guild = i.guild;
        const c = cfg(guild.id);
        const y = c.youtube.find((item) => item.id === videoId || item.seen?.includes(videoId));
        const status = infoEmbed('🔎 YOUTUBE STATUS', y ? '🟢 The channel is currently live or recently active.' : '⚫ No matching tracked YouTube channel was found for this status check.', [{ name: 'Last checked', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }]);
        return i.reply({ embeds: [status], flags: MessageFlags.Ephemeral }).catch(() => {});
      } catch (error) {
        console.error('YouTube status button failed:', error);
        return i.reply({ embeds: [errorEmbed('YOUTUBE STATUS ERROR', 'The status check could not be completed right now.')], flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    return;
  }

  if (!i.isChatInputCommand() || !i.inGuild()) return;
  if (i.commandName === 'streamcheck' && !isAdmin(i.member)) {
    const permissionText = 'You need:\n**Administrator**\n\nto use this command.';
    const p = { embeds: [errorEmbed('PERMISSION REQUIRED', permissionText)], flags: MessageFlags.Ephemeral };
    return (i.deferred || i.replied) ? i.followUp(p).catch(() => {}) : i.reply(p).catch(() => {});
  }
  if (!isMod(i.member)) {
    const permissionText = 'You need:\n**Moderate Members**\n\nto use this command.';
    const p = { embeds: [errorEmbed('PERMISSION REQUIRED', permissionText)], flags: MessageFlags.Ephemeral };
    return (i.deferred || i.replied) ? i.followUp(p).catch(() => {}) : i.reply(p).catch(() => {});
  }

  try { await H[i.commandName]?.(i); }
  catch (e) {
    console.error(e);
    const p = { embeds: [errorEmbed('SOMETHING WENT WRONG', 'I could not complete that action. Check my permissions and try again later.')], flags: MessageFlags.Ephemeral };
    (i.deferred || i.replied) ? i.followUp(p).catch(() => {}) : i.reply(p).catch(() => {});
  }
});

// ───────────────────────── Anti-Ping ─────────────────────────
client.on('messageCreate', async (msg) => {
  if (!msg.inGuild() || msg.author.bot || !msg.member) return;
  const c = cfg(msg.guildId);
  if (!c.antiping.enabled || !c.antiping.users.length) return;
  if (isMod(msg.member)) return;
  const hit = msg.mentions.users.filter((u) => c.antiping.users.includes(u.id) && u.id !== msg.author.id);
  if (!hit.size) return;

  await msg.delete().catch(() => {});
  const names = hit.map((u) => u.tag).join(', ');
  let extra = '';
  if (c.antiping.autoWarn) {
    const { count, auto } = await addWarning(msg.guild, msg.author, client.user.id, `Pinged protected user(s): ${names}`);
    extra = ` (warning ${count}${auto ? ', auto-muted 1h' : ''})`;
  }
  const notice = await msg.channel.send({ content: `${msg.author}, please don't ping protected members${extra}.` }).catch(() => null);
  setTimeout(() => notice?.delete().catch(() => {}), 8000);
  log(msg.guild, 'antiping', embed('Protected ping blocked', `**Author:** ${msg.author} (${msg.author.id})\n**Channel:** ${msg.channel}\n**Pinged:** ${hit.map((u) => `<@${u.id}>`).join(', ')}`, COLORS.warn));
});

// ───────────────────────── YouTube (RSS, no API quota) ─────────────────────────
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveYouTubeId(input) {
  const direct = /(UC[\w-]{22})/.exec(input);
  if (direct) return direct[1];

  const handle = input
    .replace(/^https?:\/\/(www\.)?youtube\.com\//i, '')
    .replace(/^@?/, '@')
    .split(/[/?]/)[0];

  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/${handle}`,
      { headers: { 'accept-language': 'en' } }
    );

    if (!res.ok) return null;

    const html = await res.text();

    return /"(?:externalId|channelId)":"(UC[\w-]{22})"/.exec(html)?.[1] ?? null;
  } catch (e) {
    console.error('YouTube channel lookup failed:', e.message);
    return null;
  }
}

async function fetchYouTubeFeed(id) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
      {},
      8000
    );

    if (!res.ok) return null;

    const xml = await res.text();

    const author =
      /<author>\s*<name>([^<]+)<\/name>/.exec(xml)?.[1] ?? 'Unknown';

    const decode = (s) =>
      s.replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'");

    const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
      .map((m) => ({
        id: /<yt:videoId>([^<]+)</.exec(m[1])?.[1],
        title: decode(/<title>([^<]+)</.exec(m[1])?.[1] ?? '')
      }))
      .filter((v) => v.id);

    return {
      author: decode(author),
      videos
    };
  } catch (e) {
    console.error('YouTube feed failed:', e.message);
    return null;
  }
}

const YT_KEY = process.env.YOUTUBE_API_KEY;
const YT_ENABLED = Boolean(YT_KEY);

// One API call (1 quota unit) checks up to 50 videos at once.
async function fetchYouTubeDetails(ids) {
  if (!YT_KEY || !ids.length) return null;
  try {
    const res = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.slice(0, 50).join(',')}&key=${YT_KEY}`, {}, 10000);
    if (!res.ok) { console.error('YouTube API error', res.status, (await res.text()).slice(0, 200)); return null; }
    const json = await res.json();
    const map = {};
    for (const v of json.items ?? []) map[v.id] = v.snippet;
    return map;
  } catch (e) { console.error('YouTube API failed', e.message); return null; }
}

async function announceYouTubeLive(guild, announceCfg, feed, video, thumb) {
  if (!announceCfg) return false;
  const url = `https://youtube.com/watch?v=${video.id}`;
  const e = buildYoutubeLiveEmbed(feed, video, thumb);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🔴 Watch on YouTube').setStyle(ButtonStyle.Link).setURL(url),
    new ButtonBuilder().setCustomId(`youtube_status_${video.id}`).setLabel('🔄 Check Status').setStyle(ButtonStyle.Secondary),
  );
  const text = `🔴 **${feed.author}** is live now!`;
  await sendTo(guild, announceCfg.channel, { content: `${announceCfg.role ? `<@&${announceCfg.role}> ` : ''}${text}\n${url}`, embeds: [e], components: [row], allowedMentions: { roles: announceCfg.role ? [announceCfg.role] : [] } });
  log(guild, 'youtube', embed('YouTube LIVE announcement sent', `**${feed.author}**: [${video.title}](${url})`, COLORS.yt));
  return true;
}

const resolveYoutubeChannel = resolveYouTubeId;
const fetchVideosInfo = fetchYouTubeDetails;
const getLatestUploadVideoId = async (channelId) => {
  const feed = await fetchYouTubeFeed(channelId);
  return feed?.videos?.[0]?.id ?? null;
};

const buildYoutubeLiveEmbed = function buildYouTubeLiveEmbed(feed, video, thumb) {
  const url = `https://youtube.com/watch?v=${video.id}`;
  return new EmbedBuilder()
    .setColor(COLORS.yt)
    .setTitle(video.title || `${feed.author} is live`)
    .setURL(url)
    .setAuthor({ name: `${feed.author} is LIVE on YouTube` })
    .setImage(thumb ?? `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`)
    .setTimestamp()
    .setFooter({ text: FOOTER_TEXT });
};

const buildYoutubeUploadEmbed = function buildYouTubeUploadEmbed(feed, video, thumb, isShort = false) {
  const url = `https://youtube.com/watch?v=${video.id}`;
  return new EmbedBuilder()
    .setColor(isShort ? 0xff8c00 : COLORS.yt)
    .setTitle(video.title || `${feed.author} posted a new video`)
    .setURL(url)
    .setAuthor({ name: isShort ? `${feed.author} posted a new Short` : `${feed.author} just uploaded a video` })
    .setImage(thumb ?? `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`)
    .setTimestamp()
    .setFooter({ text: FOOTER_TEXT });
};

async function checkYouTubeChannel(guild, y, options = {}) {
  if (!YT_ENABLED) return { sent: false, live: false, value: null };
  const { announceOnlyLive = false } = options;
  const c = cfg(guild.id);
  const a = c.announce.youtube;
  const feed = await fetchYouTubeFeed(y.id);
  if (!feed?.videos.length) return { sent: false, live: false };
  if (!Array.isArray(y.seen)) { y.seen = feed.videos.map((v) => v.id); delete y.last; save(); return { sent: false, live: false }; }
  const unseen = feed.videos.filter((v) => !y.seen.includes(v.id));
  if (!unseen.length) return { sent: false, live: false };

  let details = null;
  if (YT_KEY) {
    details = await fetchYouTubeDetails(unseen.map((v) => v.id));
    if (!details) return { sent: false, live: false };
  }

  const toSend = [];
  let currentLive = false;
  for (const v of unseen) {
    const sn = details?.[v.id];
    if (details && !sn) { y.seen.push(v.id); continue; }
    const state = sn?.liveBroadcastContent ?? 'none';
    if (state === 'upcoming') continue;
    y.seen.push(v.id);
    const done = { v, live: state === 'live', thumb: sn?.thumbnails?.maxres?.url ?? sn?.thumbnails?.high?.url };
    if (done.live) currentLive = true;
    if (done.live || !announceOnlyLive) toSend.push(done);
  }

  if (feed.videos?.length && details) {
    for (const v of feed.videos.slice(0, 8)) {
      const sn = details[v.id];
      if (sn?.liveBroadcastContent === 'live') { currentLive = true; break; }
    }
  }

  y.live = currentLive;
  y.seen = y.seen.slice(-60); save();
  if (!a) return { sent: false, live: currentLive, value: currentLive ? y.name || y.id : null };

  let sentCount = 0;
  let liveName = null;
  for (const { v, live, thumb } of toSend.slice(-3)) {
    if (live) {
      const ok = await announceYouTubeLive(guild, a, feed, v, thumb);
      if (ok) {
        sentCount += 1;
        liveName = feed.author;
      }
      continue;
    }
    if (announceOnlyLive) continue;
    const url = `https://youtube.com/watch?v=${v.id}`;
    const e = buildYoutubeUploadEmbed(feed, v, thumb, false);
    await sendTo(guild, a.channel, { content: `${a.role ? `<@&${a.role}> ` : ''}📺 **${feed.author}** has a new video!\n${url}`, embeds: [e], allowedMentions: { roles: a.role ? [a.role] : [] } });
    log(guild, 'youtube', embed('YouTube announcement sent', `**${feed.author}**: [${v.title}](${url})`, COLORS.yt));
  }

  return { sent: sentCount > 0, live: currentLive || sentCount > 0, value: liveName || (currentLive ? y.name || y.id : null) };
}

const pollYoutubeChannels = async function pollYouTube() {
  for (const guild of client.guilds.cache.values()) {
    const c = cfg(guild.id);
    if (!c.youtube.length) continue;
    for (const y of c.youtube) {
      await checkYouTubeChannel(guild, y);
    }
  }
};
const youtubeAnnouncements = { poll: pollYoutubeChannels, check: checkYouTubeChannel, announce: announceYouTubeLive };

// ───────────────────────── Kick ─────────────────────────
// Official Kick API (needs KICK_CLIENT_ID + KICK_CLIENT_SECRET). Falls back to the
// unofficial web endpoint if those are not set, but Cloudflare may block that one.
const KICK_ID = process.env.KICK_CLIENT_ID, KICK_SECRET = process.env.KICK_CLIENT_SECRET;
const KICK_ENABLED = Boolean(KICK_ID && KICK_SECRET);
let kickToken = { value: null, exp: 0 };

async function getKickToken() {
  if (kickToken.value && Date.now() < kickToken.exp - 60000) return kickToken.value;
  const res = await fetchWithTimeout('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: KICK_ID, client_secret: KICK_SECRET }),
  }, 10000);
  if (!res.ok) { console.error('Kick token error', res.status, (await res.text()).slice(0, 200)); return null; }
  const j = await res.json();
  kickToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return kickToken.value;
}

// Returns { live, title, category, thumbnail, viewers, name } or null
async function fetchKick(slug, retry = true) {
  try {
    if (!KICK_ENABLED) return null;
    const token = await getKickToken();
    if (!token) return null;
    const res = await fetchWithTimeout(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    }, 10000);
    if (res.status === 401 && retry) { kickToken = { value: null, exp: 0 }; return fetchKick(slug, false); }
    if (!res.ok) { console.error('Kick API error', res.status); return null; }
    const ch = (await res.json()).data?.[0];
    if (!ch) return null;
    const live = Boolean(ch.stream?.is_live || ch.is_live || ch.livestream?.is_live || ch.livestream);
    return {
      live,
      title: ch.stream_title ?? ch.livestream?.session_title ?? ch.title,
      category: ch.category?.name ?? ch.livestream?.categories?.[0]?.name,
      thumbnail: ch.stream?.thumbnail ?? ch.livestream?.thumbnail?.src ?? ch.livestream?.thumbnail?.url,
      viewers: ch.stream?.viewer_count ?? ch.livestream?.viewer_count,
      name: ch.slug ?? slug,
    };
  } catch (e) { console.error('Kick fetch failed', e.message); return null; }
}

const buildKickLiveEmbed = function buildKickEmbed(data) {
  const url = `https://kick.com/${data.name}`;
  const e = new EmbedBuilder()
    .setColor(COLORS.kick)
    .setTitle(data.title || `${data.name} is live!`)
    .setURL(url)
    .setAuthor({ name: `${data.name} is live on Kick` })
    .setTimestamp()
    .setFooter({ text: FOOTER_TEXT });

  if (data.category) e.addFields({ name: 'Category', value: data.category, inline: true });
  if (data.viewers != null) e.addFields({ name: 'Viewers', value: String(data.viewers), inline: true });
  if (data.thumbnail) e.setImage(data.thumbnail);
  return e;
};

async function announceKickLive(guild, announceCfg, data) {
  if (!announceCfg) return false;
  const url = `https://kick.com/${data.name}`;
  const e = buildKickLiveEmbed(data);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🔴 Watch on Kick').setStyle(ButtonStyle.Link).setURL('https://kick.com/'),
    new ButtonBuilder().setCustomId(`kick_status_${data.name}`).setLabel('🔄 Check Status').setStyle(ButtonStyle.Secondary),
  );
  await sendTo(guild, announceCfg.channel, { content: `${announceCfg.role ? `<@&${announceCfg.role}> ` : ''}🟢 **${data.name}** is live!\n${url}`, embeds: [e], components: [row], allowedMentions: { roles: announceCfg.role ? [announceCfg.role] : [] } });
  log(guild, 'kick', embed('Kick announcement sent', `**${data.name}** went live.`, COLORS.kick));
  return true;
}

async function checkKickChannel(guild, k, options = {}) {
  if (!KICK_ENABLED) return { sent: false, live: false, value: null };
  const { announceOnlyLive = false } = options;
  const c = cfg(guild.id);
  const a = c.announce.kick;
  const d = await fetchKick(k.slug);
  if (!d) return { sent: false, live: false };
  if (d.live && !k.live) {
    k.live = true; save();
    if (!a) return { sent: false, live: true, value: d.name };
    const sent = await announceKickLive(guild, a, d);
    return { sent, live: true, value: d.name };
  }
  if (!d.live && k.live) { k.live = false; save(); }
  return { sent: false, live: !!d.live, value: d.live ? d.name : null };
}

const pollKickStreams = async function pollKick() {
  for (const guild of client.guilds.cache.values()) {
    const c = cfg(guild.id);
    if (!c.kick.length) continue;
    for (const k of c.kick) {
      await checkKickChannel(guild, k);
    }
  }
};

const getKickAppToken = getKickToken;
const fetchKickChannel = fetchKick;
const kickAnnouncements = { poll: pollKickStreams, check: checkKickChannel, announce: announceKickLive };

// ───────────────────────── Boot ─────────────────────────
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`YouTube mode: ${YT_ENABLED ? 'API-backed live detection' : 'disabled (missing YOUTUBE_API_KEY)'} | Kick mode: ${KICK_ENABLED ? 'API-backed live detection' : 'disabled (missing KICK_CLIENT_ID / KICK_CLIENT_SECRET)'}`);
  client.user.setActivity('over Purnima Gaming', { type: 3 });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    await rest.put(route, { body: commands });
    console.log(`Registered ${commands.length} commands`);
  } catch (e) { console.error('Command registration failed', e); }
  setInterval(() => pollYoutubeChannels().catch(console.error), YOUTUBE_POLL_INTERVAL_MS);
  setInterval(() => pollKickStreams().catch(console.error), KICK_POLL_INTERVAL_MS);
});

process.on('unhandledRejection', (e) => console.error('Unhandled', e));
client.login(process.env.DISCORD_TOKEN);
