// Live Announcer — YouTube + Kick → Discord
// Node 18+  |  npm i discord.js
//
// ENV (rename below if yours differ):
//   DISCORD_TOKEN, KICK_CLIENT_ID, KICK_CLIENT_SECRET, YOUTUBE_API_KEY
//   DATA_DIR (optional, point to a Render Disk mount, e.g. /data)

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
const COLORS = { kick: 0x53fc18, youtube: 0xff0000, ok: 0x2ecc71, off: 0x95a5a6, err: 0xe74c3c };
const NAMES = { kick: 'Kick', youtube: 'YouTube' };

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
  if (!channel?.isTextBased()) return console.warn('Channel missing for', entry.username);

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

/* ───────────── polling ───────────── */
let polling = false;
async function poll() {
  if (polling) return; // never overlap runs → no duplicate sends
  polling = true;
  try {
    const active = db.filter(e => e.enabled);

    // Kick
    const kickEntries = active.filter(e => e.platform === 'kick');
    if (kickEntries.length) {
      try {
        const data = await kickFetch([...new Set(kickEntries.map(e => e.username))]);
        for (const e of kickEntries) {
          const c = data.get(e.username);
          if (!c) continue;
          const s = c.stream;
          await handleState(e, !!s?.is_live, s?.start_time || String(Date.now()), () => ({
            name: e.display || e.username,
            title: c.stream_title,
            category: c.category?.name,
            image: s.thumbnail ? `${s.thumbnail}${s.thumbnail.includes('?') ? '&' : '?'}t=${Date.now()}` : null,
            url: `https://kick.com/${e.username}`,
          }));
        }
      } catch (err) { console.error('Kick poll:', err.message); }
    }

    // YouTube
    const ytEntries = active.filter(e => e.platform === 'youtube');
    if (ytEntries.length) {
      try {
        const live = await ytFetchLive([...new Set(ytEntries.map(e => e.channelId))]);
        for (const e of ytEntries) {
          const v = live.get(e.channelId);
          await handleState(e, !!v, v?.id, () => ({
            name: e.display || e.username,
            title: v.snippet.title,
            avatar: e.avatar,
            image: `https://i.ytimg.com/vi/${v.id}/maxresdefault_live.jpg?t=${Date.now()}`,
            url: `https://www.youtube.com/watch?v=${v.id}`,
          }));
        }
      } catch (err) { console.error('YouTube poll:', err.message); }
    }
  } finally { polling = false; }
}

// Announce ONLY on offline → live with a new stream key.
async function handleState(entry, isLive, streamKey, buildInfo) {
  if (isLive) {
    entry.offlineStrikes = 0;
    if (!entry.live || entry.lastKey !== streamKey) {
      const isNew = entry.lastKey !== streamKey;
      entry.live = true;
      entry.lastKey = streamKey;
      save(); // persist BEFORE sending → a crash/restart can't cause a repeat
      if (isNew) {
        try { await announce(entry, buildInfo()); } catch (e) { console.error('Announce failed:', e.message); }
      }
    }
  } else if (entry.live) {
    entry.offlineStrikes = (entry.offlineStrikes || 0) + 1;
    if (entry.offlineStrikes >= OFFLINE_STRIKES_TO_RESET) { entry.live = false; save(); }
  }
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
      .addStringOption(o => userOpt(o, 'Streamer name')));

const commands = [
  addCmd('kickadd', 'Kick', 'Kick username'),
  groupCmd('kick', 'Kick'),
  addCmd('youtubeadd', 'YouTube', 'YouTube @handle, channel URL or ID'),
  groupCmd('youtube', 'YouTube'),
].map(c => c.toJSON());

const reply = (i, color, text) =>
  i.reply({ embeds: [new EmbedBuilder().setColor(color).setDescription(text)], flags: MessageFlags.Ephemeral });

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || !i.guildId) return;
  try {
    const isAdd = i.commandName.endsWith('add');
    const platform = i.commandName.startsWith('kick') ? 'kick' : 'youtube';
    const p = NAMES[platform];

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

    // /kick | /youtube  →  remove | disable
    const sub = i.options.getSubcommand(false);
    if (!sub) {
      return reply(i, COLORS.err, '⚠️ This command is outdated. Please restart Discord (Ctrl+R) and try again.');
    }
    const input = i.options.getString('user', true);
    let key = clean(input);
    if (platform === 'youtube' && !/^uc[\w-]{22}$/.test(key)) {
      // allow matching by saved display name / handle
      const hit = db.find(e => e.guildId === i.guildId && e.platform === 'youtube'
        && (e.display.toLowerCase() === key || e.display.toLowerCase().replace(/\s/g, '') === key.replace(/\s/g, '')));
      if (hit) key = hit.username;
      else { const r = await resolveYouTube(input).catch(() => null); if (r) key = r.channelId.toLowerCase(); }
    }
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

client.once(Events.ClientReady, async () => {
  // wipe old guild-scoped commands that override the new global ones
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set([]).catch(() => {});
  }
  await client.application.commands.set(commands);
  console.log(`Logged in as ${client.user.tag}`);
  poll();
  setInterval(poll, POLL_MS);
});

// Tiny HTTP server so Render Web Services stay healthy (skip if using a Background Worker)
if (process.env.PORT) require('http').createServer((_, r) => r.end('ok')).listen(process.env.PORT);

client.login(DISCORD_TOKEN);