require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  EmbedBuilder, ChannelType, MessageFlags,
} = require('discord.js');

// ───────────────────────── Settings ─────────────────────────
const BRAND = 'Purnima Gaming';
const COLORS = { main: 0x7c3aed, ok: 0x22c55e, warn: 0xf59e0b, red: 0xef4444, yt: 0xff0000, kick: 0x53fc18 };
const AUTO_MUTE_AT = 3;                 // auto-timeout when a user reaches this many warnings
const AUTO_MUTE_MS = 60 * 60 * 1000;    // 1 hour
const POLL_MS = 60 * 1000;              // YouTube + Kick check interval
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

const embed = (title, desc, color = COLORS.main) =>
  new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp().setFooter({ text: BRAND });

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
].map((c) => c.setDefaultMemberPermissions(modPerm).setDMPermission(false).toJSON());

// ───────────────────────── Handlers ─────────────────────────
const H = {
  async warn(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), reason = i.options.getString('reason');
    const member = i.options.getMember('user');
    const err = hierarchyCheck(i, member, 'warn');
    if (err) return i.editReply({ embeds: [embed('Blocked', err, COLORS.red)] });
    const { count, auto } = await addWarning(i.guild, user, i.user.id, reason);
    const e = embed('Member warned', `**User:** ${user} (${user.id})\n**Reason:** ${reason}\n**Total warnings:** ${count}${auto ? `\n**Auto-mute:** 1h (reached ${AUTO_MUTE_AT} warnings)` : ''}`, COLORS.warn);
    await dm(user, embed(`You were warned in ${i.guild.name}`, `**Reason:** ${reason}\n**Warnings:** ${count}`, COLORS.warn));
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Moderator', value: `${i.user}` }));
  },

  async warnings(i) {
    const user = i.options.getUser('user');
    const list = cfg(i.guildId).warnings[user.id] ?? [];
    const body = list.length
      ? list.slice(-10).map((w, n) => `**${list.length - Math.min(10, list.length) + n + 1}.** ${w.reason}\n<t:${Math.floor(w.at / 1000)}:R> by <@${w.mod}>`).join('\n\n')
      : 'No warnings.';
    return i.reply({ embeds: [embed(`Warnings: ${user.tag} (${list.length})`, body, COLORS.warn)] });
  },

  async clearwarnings(i) {
    const user = i.options.getUser('user');
    const c = cfg(i.guildId);
    const n = (c.warnings[user.id] ?? []).length;
    delete c.warnings[user.id]; save();
    const e = embed('Warnings cleared', `Removed **${n}** warning(s) from ${user}.`, COLORS.ok);
    await i.reply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Moderator', value: `${i.user}` }));
  },

  async mute(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const ms = parseDuration(i.options.getString('duration'));
    const reason = i.options.getString('reason') ?? 'No reason provided';
    if (!member) return i.editReply({ embeds: [embed('Error', 'That user is not in the server.', COLORS.red)] });
    if (!ms) return i.editReply({ embeds: [embed('Invalid duration', 'Use formats like `10m`, `2h`, `1d` (max 28d).', COLORS.red)] });
    const err = hierarchyCheck(i, member, 'mute');
    if (err) return i.editReply({ embeds: [embed('Blocked', err, COLORS.red)] });
    await member.timeout(ms, `${reason} | by ${i.user.tag}`);
    const e = embed('Member muted', `**User:** ${user} (${user.id})\n**Duration:** ${fmtMs(ms)}\n**Reason:** ${reason}`, COLORS.warn);
    await dm(user, embed(`You were muted in ${i.guild.name}`, `**Duration:** ${fmtMs(ms)}\n**Reason:** ${reason}`, COLORS.warn));
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Moderator', value: `${i.user}` }));
  },

  async unmute(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const reason = i.options.getString('reason') ?? 'No reason provided';
    if (!member) return i.editReply({ embeds: [embed('Error', 'That user is not in the server.', COLORS.red)] });
    await member.timeout(null, `${reason} | by ${i.user.tag}`);
    const e = embed('Member unmuted', `**User:** ${user} (${user.id})\n**Reason:** ${reason}`, COLORS.ok);
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Moderator', value: `${i.user}` }));
  },

  async kick(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const reason = i.options.getString('reason') ?? 'No reason provided';
    if (!member) return i.editReply({ embeds: [embed('Error', 'That user is not in the server.', COLORS.red)] });
    const err = hierarchyCheck(i, member, 'kick');
    if (err) return i.editReply({ embeds: [embed('Blocked', err, COLORS.red)] });
    await dm(user, embed(`You were kicked from ${i.guild.name}`, `**Reason:** ${reason}`, COLORS.red));
    await member.kick(`${reason} | by ${i.user.tag}`);
    const e = embed('Member kicked', `**User:** ${user} (${user.id})\n**Reason:** ${reason}`, COLORS.red);
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Moderator', value: `${i.user}` }));
  },

  async ban(i) {
    await i.deferReply();
    const user = i.options.getUser('user'), member = i.options.getMember('user');
    const reason = i.options.getString('reason') ?? 'No reason provided';
    const days = i.options.getInteger('delete_days') ?? 0;
    const err = hierarchyCheck(i, member, 'ban');
    if (err) return i.editReply({ embeds: [embed('Blocked', err, COLORS.red)] });
    if (member) await dm(user, embed(`You were banned from ${i.guild.name}`, `**Reason:** ${reason}`, COLORS.red));
    await i.guild.members.ban(user.id, { reason: `${reason} | by ${i.user.tag}`, deleteMessageSeconds: days * 86400 });
    const e = embed('Member banned', `**User:** ${user} (${user.id})\n**Reason:** ${reason}`, COLORS.red);
    await i.editReply({ embeds: [e] });
    log(i.guild, 'moderation', e.addFields({ name: 'Moderator', value: `${i.user}` }));
  },

  async unban(i) {
    await i.deferReply();
    const id = i.options.getString('user_id').trim();
    const reason = i.options.getString('reason') ?? 'No reason provided';
    await i.guild.members.unban(id, `${reason} | by ${i.user.tag}`).catch(() => null)
      .then(async (r) => {
        if (!r) return i.editReply({ embeds: [embed('Error', 'That user is not banned (or the ID is invalid).', COLORS.red)] });
        const e = embed('User unbanned', `**User:** <@${id}> (${id})\n**Reason:** ${reason}`, COLORS.ok);
        await i.editReply({ embeds: [e] });
        log(i.guild, 'moderation', e.addFields({ name: 'Moderator', value: `${i.user}` }));
      });
  },

  async setlogs(i) {
    const feature = i.options.getString('feature'), ch = i.options.getChannel('channel');
    const c = cfg(i.guildId);
    if (ch) c.logs[feature] = ch.id; else delete c.logs[feature];
    save();
    const e = embed('Log channel updated', `**${feature}** logs → ${ch ?? '*disabled*'}`, COLORS.ok);
    await i.reply({ embeds: [e] });
    if (ch) log(i.guild, 'config', e.addFields({ name: 'By', value: `${i.user}` }));
  },

  async setannounce(i) {
    const p = i.options.getString('platform'), ch = i.options.getChannel('channel'), role = i.options.getRole('ping_role');
    cfg(i.guildId).announce[p] = { channel: ch.id, role: role?.id ?? null };
    save();
    const e = embed('Announcement channel set', `**${p}** → ${ch}${role ? `\nPing: ${role}` : ''}`, COLORS.ok);
    await i.reply({ embeds: [e] });
    log(i.guild, 'config', e.addFields({ name: 'By', value: `${i.user}` }));
  },

  async youtube(i) {
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'list') {
      const t = c.youtube.length ? c.youtube.map((y) => `• **${y.name}** (\`${y.id}\`)`).join('\n') : 'Nothing tracked yet.';
      return i.reply({ embeds: [embed('Tracked YouTube channels', t, COLORS.yt)] });
    }
    const input = i.options.getString('channel').trim();
    if (sub === 'remove') {
      const before = c.youtube.length;
      c.youtube = c.youtube.filter((y) => y.id !== input && y.name.toLowerCase() !== input.toLowerCase());
      save();
      return i.reply({ embeds: [embed('YouTube', before === c.youtube.length ? 'Channel not found.' : 'Channel removed.', before === c.youtube.length ? COLORS.red : COLORS.ok)] });
    }
    await i.deferReply();
    const id = await resolveYouTubeId(input);
    if (!id) return i.editReply({ embeds: [embed('Error', 'Could not find that channel. Use the channel ID (starts with `UC`).', COLORS.red)] });
    if (c.youtube.some((y) => y.id === id)) return i.editReply({ embeds: [embed('Already tracked', 'That channel is already in the list.', COLORS.warn)] });
    const feed = await fetchYouTubeFeed(id);
    if (!feed) return i.editReply({ embeds: [embed('Error', 'Could not read that channel\'s feed.', COLORS.red)] });
    c.youtube.push({ id, name: feed.author, seen: feed.videos.map((v) => v.id) }); // baseline: don't announce old videos
    save();
    const e = embed('YouTube channel added', `Now tracking **${feed.author}**.`, COLORS.ok);
    await i.editReply({ embeds: [e] });
    log(i.guild, 'config', e.addFields({ name: 'By', value: `${i.user}` }));
  },

  async kicklive(i) {
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'list') {
      const t = c.kick.length ? c.kick.map((k) => `• **${k.slug}**`).join('\n') : 'Nothing tracked yet.';
      return i.reply({ embeds: [embed('Tracked Kick streamers', t, COLORS.kick)] });
    }
    const slug = i.options.getString('username').trim().toLowerCase();
    if (sub === 'remove') {
      const before = c.kick.length;
      c.kick = c.kick.filter((k) => k.slug !== slug); save();
      return i.reply({ embeds: [embed('Kick', before === c.kick.length ? 'Streamer not found.' : 'Streamer removed.', before === c.kick.length ? COLORS.red : COLORS.ok)] });
    }
    if (c.kick.some((k) => k.slug === slug)) return i.reply({ embeds: [embed('Already tracked', 'Already in the list.', COLORS.warn)] });
    c.kick.push({ slug, live: false }); save();
    const e = embed('Kick streamer added', `Now tracking **${slug}**.`, COLORS.ok);
    await i.reply({ embeds: [e] });
    log(i.guild, 'config', e.addFields({ name: 'By', value: `${i.user}` }));
  },

  async antiping(i) {
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'list') {
      const t = c.antiping.users.length ? c.antiping.users.map((u) => `• <@${u}>`).join('\n') : 'No protected users.';
      return i.reply({ embeds: [embed(`Anti-Ping (${c.antiping.enabled ? 'ON' : 'OFF'})`, t)] });
    }
    if (sub === 'toggle') {
      c.antiping.enabled = i.options.getBoolean('enabled');
      const aw = i.options.getBoolean('autowarn');
      if (aw !== null) c.antiping.autoWarn = aw;
      save();
      return i.reply({ embeds: [embed('Anti-Ping updated', `Enabled: **${c.antiping.enabled}** | Auto-warn: **${c.antiping.autoWarn}**`, COLORS.ok)] });
    }
    const user = i.options.getUser('user');
    if (sub === 'add') { if (!c.antiping.users.includes(user.id)) c.antiping.users.push(user.id); }
    else c.antiping.users = c.antiping.users.filter((u) => u !== user.id);
    save();
    const e = embed('Anti-Ping updated', `${user} ${sub === 'add' ? 'is now protected' : 'is no longer protected'}.`, COLORS.ok);
    await i.reply({ embeds: [e] });
    log(i.guild, 'antiping', e.addFields({ name: 'By', value: `${i.user}` }));
  },

  async modrole(i) {
    if (!isAdmin(i.member)) return i.reply({ embeds: [embed('Admins only', 'Only admins can change mod roles.', COLORS.red)], flags: MessageFlags.Ephemeral });
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'list') return i.reply({ embeds: [embed('Mod roles', c.modRoles.length ? c.modRoles.map((r) => `• <@&${r}>`).join('\n') : 'None set. Admins/Manage Server only.')] });
    const role = i.options.getRole('role');
    if (sub === 'add') { if (!c.modRoles.includes(role.id)) c.modRoles.push(role.id); }
    else c.modRoles = c.modRoles.filter((r) => r !== role.id);
    save();
    const e = embed('Mod roles updated', `${role} ${sub === 'add' ? 'added' : 'removed'}.`, COLORS.ok);
    await i.reply({ embeds: [e] });
    log(i.guild, 'config', e.addFields({ name: 'By', value: `${i.user}` }));
  },
};

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || !i.inGuild()) return;
  if (!isMod(i.member))
    return i.reply({ embeds: [embed('Mods only', 'You need to be a moderator to use this bot.', COLORS.red)], flags: MessageFlags.Ephemeral });
  try { await H[i.commandName]?.(i); }
  catch (e) {
    console.error(e);
    const p = { embeds: [embed('Error', 'Something went wrong. Check my permissions and try again.', COLORS.red)], flags: MessageFlags.Ephemeral };
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
async function resolveYouTubeId(input) {
  const direct = /(UC[\w-]{22})/.exec(input);
  if (direct) return direct[1];
  const handle = input.replace(/^https?:\/\/(www\.)?youtube\.com\//i, '').replace(/^@?/, '@').split(/[/?]/)[0];
  try {
    const html = await (await fetch(`https://www.youtube.com/${handle}`, { headers: { 'accept-language': 'en' } })).text();
    return /"(?:externalId|channelId)":"(UC[\w-]{22})"/.exec(html)?.[1] ?? null;
  } catch { return null; }
}

async function fetchYouTubeFeed(id) {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
    if (!res.ok) return null;
    const xml = await res.text();
    const author = /<author>\s*<name>([^<]+)<\/name>/.exec(xml)?.[1] ?? 'Unknown';
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      id: /<yt:videoId>([^<]+)</.exec(m[1])?.[1],
      title: decode(/<title>([^<]+)</.exec(m[1])?.[1] ?? ''),
    })).filter((v) => v.id);
    return { author: decode(author), videos };
  } catch { return null; }
}

const YT_KEY = process.env.YOUTUBE_API_KEY;

// One API call (1 quota unit) checks up to 50 videos at once.
async function fetchYouTubeDetails(ids) {
  if (!YT_KEY || !ids.length) return null;
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.slice(0, 50).join(',')}&key=${YT_KEY}`);
    if (!res.ok) { console.error('YouTube API error', res.status, (await res.text()).slice(0, 200)); return null; }
    const json = await res.json();
    const map = {};
    for (const v of json.items ?? []) map[v.id] = v.snippet;
    return map;
  } catch (e) { console.error('YouTube API failed', e.message); return null; }
}

async function pollYouTube() {
  for (const guild of client.guilds.cache.values()) {
    const c = cfg(guild.id), a = c.announce.youtube;
    if (!c.youtube.length) continue;
    for (const y of c.youtube) {
      const feed = await fetchYouTubeFeed(y.id);
      if (!feed?.videos.length) continue;
      // First run (or upgrade from old data): remember what exists, announce nothing old.
      if (!Array.isArray(y.seen)) { y.seen = feed.videos.map((v) => v.id); delete y.last; save(); continue; }
      const unseen = feed.videos.filter((v) => !y.seen.includes(v.id));
      if (!unseen.length) continue;

      let details = null;
      if (YT_KEY) {
        details = await fetchYouTubeDetails(unseen.map((v) => v.id));
        if (!details) continue; // API hiccup: try again next cycle instead of guessing
      }
      const toSend = [];
      for (const v of unseen) {
        const sn = details?.[v.id];
        if (details && !sn) { y.seen.push(v.id); continue; }            // deleted/private
        const state = sn?.liveBroadcastContent ?? 'none';
        if (state === 'upcoming') continue;                              // scheduled: wait until it really starts
        y.seen.push(v.id);
        toSend.push({ v, live: state === 'live', thumb: sn?.thumbnails?.maxres?.url ?? sn?.thumbnails?.high?.url });
      }
      y.seen = y.seen.slice(-60); save();
      if (!a) continue;

      for (const { v, live, thumb } of toSend.slice(-3)) {
        const url = `https://youtu.be/${v.id}`;
        const e = new EmbedBuilder().setColor(COLORS.yt).setTitle(v.title).setURL(url)
          .setAuthor({ name: live ? `${feed.author} is LIVE on YouTube` : `${feed.author} just posted on YouTube` })
          .setImage(thumb ?? `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`).setTimestamp().setFooter({ text: BRAND });
        const text = live ? `🔴 **${feed.author}** is live now!` : `**${feed.author}** has a new video!`;
        await sendTo(guild, a.channel, { content: `${a.role ? `<@&${a.role}> ` : ''}${text}\n${url}`, embeds: [e], allowedMentions: { roles: a.role ? [a.role] : [] } });
        log(guild, 'youtube', embed(live ? 'YouTube LIVE announcement sent' : 'YouTube announcement sent', `**${feed.author}**: [${v.title}](${url})`, COLORS.yt));
      }
    }
  }
}

// ───────────────────────── Kick ─────────────────────────
// Official Kick API (needs KICK_CLIENT_ID + KICK_CLIENT_SECRET). Falls back to the
// unofficial web endpoint if those are not set, but Cloudflare may block that one.
const KICK_ID = process.env.KICK_CLIENT_ID, KICK_SECRET = process.env.KICK_CLIENT_SECRET;
let kickToken = { value: null, exp: 0 };

async function getKickToken() {
  if (kickToken.value && Date.now() < kickToken.exp - 60000) return kickToken.value;
  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: KICK_ID, client_secret: KICK_SECRET }),
  });
  if (!res.ok) { console.error('Kick token error', res.status, (await res.text()).slice(0, 200)); return null; }
  const j = await res.json();
  kickToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return kickToken.value;
}

// Returns { live, title, category, thumbnail, viewers, name } or null
async function fetchKick(slug, retry = true) {
  try {
    if (KICK_ID && KICK_SECRET) {
      const token = await getKickToken();
      if (!token) return null;
      const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (res.status === 401 && retry) { kickToken = { value: null, exp: 0 }; return fetchKick(slug, false); }
      if (!res.ok) { console.error('Kick API error', res.status); return null; }
      const ch = (await res.json()).data?.[0];
      if (!ch) return null;
      return { live: !!ch.stream?.is_live, title: ch.stream_title, category: ch.category?.name, thumbnail: ch.stream?.thumbnail, viewers: ch.stream?.viewer_count, name: ch.slug ?? slug };
    }
    const res = await fetch(`https://kick.com/api/v2/channels/${slug}`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const d = await res.json();
    return { live: !!d.livestream, title: d.livestream?.session_title, category: d.livestream?.categories?.[0]?.name, thumbnail: d.livestream?.thumbnail?.src ?? d.livestream?.thumbnail?.url, name: d.user?.username ?? slug };
  } catch (e) { console.error('Kick fetch failed', e.message); return null; }
}

async function pollKick() {
  for (const guild of client.guilds.cache.values()) {
    const c = cfg(guild.id), a = c.announce.kick;
    if (!c.kick.length) continue;
    for (const k of c.kick) {
      const d = await fetchKick(k.slug);
      if (!d) continue;
      if (d.live && !k.live) {
        k.live = true; save();
        if (!a) continue;
        const e = new EmbedBuilder().setColor(COLORS.kick).setTitle(d.title || `${d.name} is live!`).setURL(`https://kick.com/${k.slug}`)
          .setAuthor({ name: `${d.name} is live on Kick` })
          .addFields({ name: 'Category', value: d.category ?? 'Unknown', inline: true })
          .setTimestamp().setFooter({ text: BRAND });
        if (d.viewers != null) e.addFields({ name: 'Viewers', value: String(d.viewers), inline: true });
        if (d.thumbnail) e.setImage(d.thumbnail);
        await sendTo(guild, a.channel, { content: `${a.role ? `<@&${a.role}> ` : ''}🟢 **${d.name}** is live!\nhttps://kick.com/${k.slug}`, embeds: [e], allowedMentions: { roles: a.role ? [a.role] : [] } });
        log(guild, 'kick', embed('Kick announcement sent', `**${k.slug}** went live.`, COLORS.kick));
      } else if (!d.live && k.live) { k.live = false; save(); }
    }
  }
}

// ───────────────────────── Boot ─────────────────────────
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`YouTube mode: ${YT_KEY ? 'API (exact live detection)' : 'RSS only (no key)'} | Kick mode: ${KICK_ID && KICK_SECRET ? 'official API' : 'unofficial endpoint'}`);
  client.user.setActivity('over Purnima Gaming', { type: 3 });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    await rest.put(route, { body: commands });
    console.log(`Registered ${commands.length} commands`);
  } catch (e) { console.error('Command registration failed', e); }
  setInterval(() => pollYouTube().catch(console.error), POLL_MS);
  setInterval(() => pollKick().catch(console.error), POLL_MS);
});

process.on('unhandledRejection', (e) => console.error('Unhandled', e));
client.login(process.env.DISCORD_TOKEN);
