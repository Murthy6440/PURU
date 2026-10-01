// Live Announcer — YouTube + Kick → Discord
// Node 18+  |  npm i discord.js
//
// ENV (rename below if yours differ):
//   DISCORD_TOKEN, KICK_CLIENT_ID, KICK_CLIENT_SECRET, YOUTUBE_API_KEY
//   DATA_DIR (optional, point to a Render Disk mount, e.g. /data)
//
// Commands:
//   /kickadd user channel ping      /youtubeadd user channel ping
//   /kick remove user               /youtube remove user
//   /kick disable user              /youtube disable user
//   /kick recheck [user]            /youtube recheck [user]

const fs = require('fs');
const path = require('path');
const {
  Client, Events, GatewayIntentBits, SlashCommandBuilder, ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const {
  DISCORD_TOKEN, KICK_CLIENT_ID, KICK_CLIENT_SECRET, YOUTUBE_API_KEY,
  DATA_DIR = __dirname,
} = process.env;

const POLL_MS = 30_000;
const OFFLINE_STRIKES_TO_RESET = 2; // avoids re-announcing on short stream drops
const DB_FILE = path.join(DATA_DIR, 'streamers.json');
const COLORS = { kick: 0x53fc18, youtube: 0xff0000, ok: 0x2ecc71, off: 0x95a5a6, err: 0xe74c3c, info: 0x5865f2 };
const NAMES = { kick: 'Kick', youtube: 'YouTube' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────── storage (tiny JSON db) ───────────── */
let db = [];
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = []; }
const save = () => {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
};
const find = (guildId, platform, username) =>
  db.find(e => e.guildId === guildId && e.platform === platform && e.username === username);

/* ───────────── helpers ───────────── */
const clean = s => s.trim().replace(/^@+/, '').toLowerCase(); // strips any leading @ → no "@@"

// Build the ping from IDs only (never from user text) → can't produce double @@
function pingText(roleId, guildId) {
  if (!roleId) return '';
  return roleId === guildId ? '@everyone' : `<@&${roleId}>`;
}
function allowedMentions(roleId, guildId) {
  if (!roleId) return { parse: [] };
  return roleId === guildId ? { parse: ['everyone'] } : { parse: [], roles: [roleId] };
}
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

/* ───────────── Kick ───────────── */
let kickToken = { value: null, exp: 0 };
async function getKickToken() {
  if (kickToken.value && Date.now() < kickToken.exp) return kickToken.value;
  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: KICK_CLIENT_ID, client_secret: KICK_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Kick token ${res.status}`);
  const j = await res.json();
  kickToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return kickToken.value;
}
// returns Map(slug → channel data)
async function kickFetch(slugs) {
  const out = new Map();
  const token = await getKickToken();
  for (let i = 0; i < slugs.length; i += 50) {
    const qs = new URLSearchParams();
    slugs.slice(i, i + 50).forEach(s => qs.append('slug', s));
    const res = await fetch(`https://api.kick.com/public/v1/channels?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) { kickToken.value = null; throw new Error('Kick 401'); }
    if (!res.ok) throw new Error(`Kick ${res.status}`);
    for (const c of (await res.json()).data || []) out.set(c.slug.toLowerCase(), c);
  }
  return out;
}

/* ───────────── YouTube ───────────── */
async function yt(endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: YOUTUBE_API_KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`YouTube ${endpoint} ${res.status}`);
  return res.json();
}
// accepts @handle, handle, channel URL, or UC… id
async function resolveYouTube(input) {
  const raw = input.trim();
  const idMatch = raw.match(/UC[\w-]{22}/);
  let params;
  if (idMatch) params = { id: idMatch[0] };
  else {
    const h = raw.match(/@([\w.\-]+)/)?.[1] || raw.replace(/^@+/, '');
    params = { forHandle: '@' + h };
  }
  const j = await yt('channels', { part: 'snippet', ...params });
  const c = j.items?.[0];
  if (!c) return null;
  return { channelId: c.id, display: c.snippet.title, avatar: c.snippet.thumbnails?.default?.url };
}
// Cheap & quota-friendly: free RSS feed finds recent uploads/streams,
// then ONE batched videos.list (1 unit) checks which are live.
async function ytFetchLive(channelIds) {
  const candidates = new Map(); // videoId → channelId
  await Promise.all(channelIds.map(async cid => {
    try {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`);
      if (!res.ok) return;
      const ids = [...(await res.text()).matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].slice(0, 5);
      ids.forEach(m => candidates.set(m[1], cid));
    } catch { /* skip this channel this round */ }
  }));
  const live = new Map(); // channelId → video
  const vids = [...candidates.keys()];
  for (let i = 0; i < vids.length; i += 50) {
    const j = await yt('videos', { part: 'snippet,liveStreamingDetails', id: vids.slice(i, i + 50).join(',') });
    for (const v of j.items || []) {
      if (v.snippet.liveBroadcastContent === 'live') live.set(v.snippet.channelId, v);
    }
  }
  return live;
}

/* ───────────── announcement ───────────── */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function announce(entry, info) {
  const channel = await client.channels.fetch(entry.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error(`Channel missing for ${entry.username}`);

  const p = NAMES[entry.platform];
  const embed = new EmbedBuilder()
    .setColor(COLORS[entry.platform])
    .setAuthor({ name: `${info.name} is LIVE on ${p}`, iconURL: info.avatar || undefined, url: info.url })
    .setTitle(trunc(info.title || 'Untitled stream', 256))
    .setURL(info.url)
    .setDescription(`🔴 **${info.name}** just went live — come hang out!`)
    .setTimestamp();
  if (info.category) embed.addFields({ name: '🎮 Category', value: trunc(info.category, 100), inline: true });
  embed.addFields({ name: '📺 Platform', value: p, inline: true });
  if (info.image) embed.setImage(info.image);
  embed.setFooter({ text: `${p} Live Alerts` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Watch now').setEmoji('▶️').setStyle(ButtonStyle.Link).setURL(info.url),
  );

  const ping = pingText(entry.pingRoleId, entry.guildId);
  await channel.send({
    content: `${ping ? ping + ' ' : ''}🚨 **${info.name}** is live on **${p}**!`.trim(),
    embeds: [embed],
    components: [row],
    allowedMentions: allowedMentions(entry.pingRoleId, entry.guildId),
  });
}

/* ───────────── checking (shared by the 30s poll AND /recheck) ───────────── */
// Announce ONLY on offline → live with a new stream key (or when force=true).
// Returns { announced, error }. If sending fails, state is rolled back so the next check retries.
async function handleState(entry, isLive, streamKey, buildInfo, force = false) {
  if (isLive) {
    entry.offlineStrikes = 0;
    const isNew = entry.lastKey !== streamKey;
    if (isNew || force) {
      const prev = { live: entry.live, lastKey: entry.lastKey };
      entry.live = true;
      entry.lastKey = streamKey;
      save(); // persist BEFORE sending → a crash/restart can't cause a repeat
      try {
        await announce(entry, buildInfo());
        return { announced: true };
      } catch (e) {
        console.error('Announce failed:', e.message);
        entry.live = prev.live; // roll back so it retries instead of being marked "announced"
        entry.lastKey = prev.lastKey;
        save();
        return { announced: false, error: e.message };
      }
    }
    if (!entry.live) { entry.live = true; save(); }
  } else if (entry.live) {
    entry.offlineStrikes = (entry.offlineStrikes || 0) + 1;
    if (entry.offlineStrikes >= OFFLINE_STRIKES_TO_RESET) { entry.live = false; save(); }
  }
  return { announced: false };
}

// Checks the given entries once. Returns { results: [{entry, live, announced, error}], errors: [string] }
async function checkEntries(entries, force = false) {
  const results = [];
  const errors = [];

  const kickEntries = entries.filter(e => e.platform === 'kick');
  if (kickEntries.length) {
    try {
      const data = await kickFetch([...new Set(kickEntries.map(e => e.username))]);
      for (const e of kickEntries) {
        const c = data.get(e.username);
        if (!c) { errors.push(`Kick: ${e.display || e.username} not found`); continue; }
        const s = c.stream;
        const st = await handleState(e, !!s?.is_live, s?.start_time || String(Date.now()), () => ({
          name: e.display || e.username,
          title: c.stream_title,
          category: c.category?.name,
          image: s.thumbnail ? `${s.thumbnail}${s.thumbnail.includes('?') ? '&' : '?'}t=${Date.now()}` : null,
          url: `https://kick.com/${e.username}`,
        }), force);
        results.push({ entry: e, live: !!s?.is_live, ...st });
      }
    } catch (err) { errors.push(`Kick: ${err.message}`); }
  }

  const ytEntries = entries.filter(e => e.platform === 'youtube');
  if (ytEntries.length) {
    try {
      const live = await ytFetchLive([...new Set(ytEntries.map(e => e.channelId))]);
      for (const e of ytEntries) {
        const v = live.get(e.channelId);
        const st = await handleState(e, !!v, v?.id, () => ({
          name: e.display || e.username,
          title: v.snippet.title,
          avatar: e.avatar,
          image: `https://i.ytimg.com/vi/${v.id}/maxresdefault_live.jpg?t=${Date.now()}`,
          url: `https://www.youtube.com/watch?v=${v.id}`,
        }), force);
        results.push({ entry: e, live: !!v, ...st });
      }
    } catch (err) { errors.push(`YouTube: ${err.message}`); }
  }
  return { results, errors };
}

// One check at a time (poll + manual rechecks can never overlap → no duplicate sends)
let busy = false;
async function runExclusive(entries, force = false) {
  while (busy) await sleep(300);
  busy = true;
  try { return await checkEntries(entries, force); } finally { busy = false; }
}
async function poll() {
  if (busy) return; // previous run still going — skip this tick
  const { errors } = await runExclusive(db.filter(e => e.enabled));
  errors.forEach(e => console.error('Poll error:', e));
}

/* ───────────── commands ───────────── */
const manage = PermissionFlagsBits.ManageGuild;
const userOpt = (o, desc) => o.setName('user').setDescription(desc).setRequired(true);

const addCmd = (name, platform, hint) =>
  new SlashCommandBuilder().setName(name)
    .setDescription(`Announce when a ${platform} streamer goes live`)
    .setDefaultMemberPermissions(manage)
    .addStringOption(o => userOpt(o, hint))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post the announcement')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addRoleOption(o => o.setName('ping').setDescription('Role to ping (optional, @everyone allowed)'));

const groupCmd = (name, platform) =>
  new SlashCommandBuilder().setName(name)
    .setDescription(`Manage ${platform} live alerts`)
    .setDefaultMemberPermissions(manage)
    .addSubcommand(s => s.setName('remove').setDescription('Stop tracking and delete a streamer')
      .addStringOption(o => userOpt(o, 'Streamer name')))
    .addSubcommand(s => s.setName('disable').setDescription('Pause alerts (re-run the add command to resume)')
      .addStringOption(o => userOpt(o, 'Streamer name')))
    .addSubcommand(s => s.setName('recheck').setDescription('Check right now if streamers are live')
      .addStringOption(o => o.setName('user').setDescription('Streamer name (leave empty to check everyone)'))
      .addBooleanOption(o => o.setName('force').setDescription('Re-send the announcement even if already announced')));

const commands = [
  addCmd('kickadd', 'Kick', 'Kick username'),
  groupCmd('kick', 'Kick'),
  addCmd('youtubeadd', 'YouTube', 'YouTube @handle, channel URL or ID'),
  groupCmd('youtube', 'YouTube'),
].map(c => c.toJSON());

const reply = (i, color, text) =>
  i.reply({ embeds: [new EmbedBuilder().setColor(color).setDescription(text)], flags: MessageFlags.Ephemeral });

// turn typed input into the stored key for this platform
async function resolveKey(guildId, platform, input) {
  let key = clean(input);
  if (platform === 'youtube' && !/^uc[\w-]{22}$/.test(key)) {
    const norm = s => s.toLowerCase().replace(/\s/g, '');
    const hit = db.find(e => e.guildId === guildId && e.platform === 'youtube'
      && (norm(e.display) === norm(key)));
    if (hit) return hit.username;
    const r = await resolveYouTube(input).catch(() => null);
    if (r) key = r.channelId.toLowerCase();
  }
  return key;
}

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || !i.guildId) return;
  try {
    const isAdd = i.commandName.endsWith('add');
    const platform = i.commandName.startsWith('kick') ? 'kick' : 'youtube';
    const p = NAMES[platform];

    /* ── /kickadd | /youtubeadd ── */
    if (isAdd) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const input = i.options.getString('user', true);
      const channel = i.options.getChannel('channel', true);
      const role = i.options.getRole('ping');
      const done = (color, text) => i.editReply({ embeds: [new EmbedBuilder().setColor(color).setDescription(text)] });

      let entry = { platform, guildId: i.guildId, channelId: channel.id, pingRoleId: role?.id || null,
        enabled: true, live: false, lastKey: null, offlineStrikes: 0 };

      if (platform === 'kick') {
        const slug = clean(input);
        const data = await kickFetch([slug]);
        const c = data.get(slug);
        if (!c) return done(COLORS.err, `❌ Couldn't find **${slug}** on Kick.`);
        Object.assign(entry, { username: slug, display: c.slug });
        if (c.stream?.is_live) Object.assign(entry, { live: true, lastKey: c.stream.start_time });
      } else {
        const r = await resolveYouTube(input);
        if (!r) return done(COLORS.err, `❌ Couldn't find that YouTube channel. Try the @handle or channel ID.`);
        Object.assign(entry, { username: r.channelId.toLowerCase(), channelId: r.channelId, display: r.display, avatar: r.avatar });
        const live = await ytFetchLive([r.channelId]);
        if (live.has(r.channelId)) Object.assign(entry, { live: true, lastKey: live.get(r.channelId).id });
      }
      // Already-live streams are recorded silently so adding someone never triggers an old-stream announcement.
      const existing = find(i.guildId, platform, entry.username);
      if (existing) Object.assign(existing, entry); else db.push(entry);
      save();

      const ping = pingText(entry.pingRoleId, i.guildId) || 'no ping';
      return done(COLORS.ok,
        `✅ **${entry.display}** added on ${p}\n📢 Channel: <#${channel.id}>\n🔔 Ping: ${ping}\n⏱️ Checked every 30 seconds`);
    }

    /* ── /kick | /youtube → remove | disable | recheck ── */
    const sub = i.options.getSubcommand(false);
    if (!sub) {
      return reply(i, COLORS.err, '⚠️ This command is outdated. Please restart Discord (Ctrl+R) and try again.');
    }

    // recheck
    if (sub === 'recheck') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const input = i.options.getString('user');
      const force = i.options.getBoolean('force') ?? false;
      let list = db.filter(e => e.guildId === i.guildId && e.platform === platform);

      if (input) {
        const key = await resolveKey(i.guildId, platform, input);
        list = list.filter(e => e.username === key);
        if (!list.length) {
          return i.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.err)
            .setDescription(`❌ **${input}** isn't being tracked on ${p}.`)] });
        }
      }
      if (!list.length) {
        return i.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.off)
          .setDescription(`No ${p} streamers added yet. Use \`/${platform}add\` first.`)] });
      }

      const paused = list.filter(e => !e.enabled);
      const { results, errors } = await runExclusive(list.filter(e => e.enabled), force);

      const lines = [
        ...results.map(r => {
          const name = `**${r.entry.display}**`;
          if (!r.live) return `⚫ ${name} — offline`;
          if (r.error) return `⚠️ ${name} — live, but the announcement FAILED: ${r.error}\n   ↳ Check the bot's permissions in <#${r.entry.channelId}> (View Channel, Send Messages, Embed Links)`;
          return r.announced ? `🔴 ${name} — live · announcement sent` : `🔴 ${name} — live · already announced`;
        }),
        ...paused.map(e => `⏸️ **${e.display}** — disabled`),
        ...errors.map(e => `⚠️ ${e}`),
      ];
      return i.editReply({ embeds: [new EmbedBuilder()
        .setColor(COLORS[platform])
        .setTitle(`${p} recheck`)
        .setDescription(lines.join('\n') || 'Nothing to check.')
        .setFooter({ text: 'Only new streams get announced — no duplicates' })
        .setTimestamp()] });
    }

    // remove | disable
    const input = i.options.getString('user', true);
    const key = await resolveKey(i.guildId, platform, input);
    const entry = find(i.guildId, platform, key);
    if (!entry) return reply(i, COLORS.err, `❌ **${input}** isn't being tracked on ${p}.`);

    if (sub === 'remove') {
      db = db.filter(e => e !== entry); save();
      return reply(i, COLORS.ok, `🗑️ Removed **${entry.display}** from ${p} alerts.`);
    }
    entry.enabled = false; save();
    return reply(i, COLORS.off, `⏸️ Alerts for **${entry.display}** on ${p} are disabled.\nRe-run \`/${platform}add\` to turn them back on.`);
  } catch (err) {
    console.error(err);
    const payload = { embeds: [new EmbedBuilder().setColor(COLORS.err).setDescription('⚠️ Something went wrong. Please try again.')] };
    if (i.deferred || i.replied) i.editReply(payload).catch(() => {});
    else i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function registerCommands() {
  try {
    await client.application.commands.set([]); // clear global copies (prevents duplicates)
    for (const guild of client.guilds.cache.values()) {
      await guild.commands.set(commands);
      console.log(`✅ Registered ${commands.length} commands in ${guild.name}`);
    }
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  poll();
  setInterval(poll, POLL_MS);
});

// register instantly when the bot is added to a new server
client.on(Events.GuildCreate, guild =>
  guild.commands.set(commands).catch(console.error));

// Tiny HTTP server so Render Web Services stay healthy (skip if using a Background Worker)
if (process.env.PORT) require('http').createServer((_, r) => r.end('ok')).listen(process.env.PORT);

client.login(DISCORD_TOKEN);