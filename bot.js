// PURNIMA — Kick + YouTube live announcer for Discord  (SINGLE FILE — only bot.js + package.json needed)
// Render env: DISCORD_TOKEN, KICK_CLIENT_ID, KICK_CLIENT_SECRET, YOUTUBE_API_KEY  (optional: DATA_DIR)
try { require('dotenv').config(); } catch { /* dotenv is optional on Render */ }

// streams.js — Kick + YouTube live announcements (drop-in module for the PURNIMA bot)
// Needs: Node 18+, discord.js v14.  Env: KICK_CLIENT_ID, KICK_CLIENT_SECRET, YOUTUBE_API_KEY
// Optional env: DATA_DIR (put it on a Render Disk, e.g. /data, so the streamer list survives deploys)
//
// Commands (all need Administrator or Manage Server):
//   /kickadd user channel [ping]      /youtubeadd user channel [ping]
//   /kickremove user                  /youtuberemove user
//   /kickdisable user                 /youtubedisable user
//   /kickrecheck [user] [force]       /youtuberecheck [user] [force]
//   /kicklist                         /youtubelist

const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, Client, Events, GatewayIntentBits, ActivityType,
} = require('discord.js');
const http = require('http');

const BRAND = 'PURNIMA';
const POLL_MS = 30_000;
const OFFLINE_STRIKES_TO_RESET = 2; // must be offline 2 checks in a row before a new stream counts as "new"
const COLORS = { kick: 0x53fc18, youtube: 0xff0000, ok: 0x2ecc71, off: 0x95a5a6, err: 0xe74c3c, info: 0x3498db };
const NAMES = { kick: 'Kick', youtube: 'YouTube' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = k => process.env[k];

let client = null;

/* ───────────── storage (JSON file, survives restarts) ───────────── */
const DB_FILE = path.join(env('DATA_DIR') || __dirname, 'streamers.json');
let db = [];
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = []; }
function save() {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('streams: could not save', e.message); }
}
const find = (guildId, platform, username) =>
  db.find(e => e.guildId === guildId && e.platform === platform && e.username === username);

/* ───────────── helpers ───────────── */
const norm = s => String(s || '').toLowerCase().replace(/[\s@]/g, '');
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const kickSlug = s => s.trim().replace(/^https?:\/\/(www\.)?kick\.com\//i, '').split(/[/?#]/)[0].replace(/^@+/, '').toLowerCase();

// Ping is built from role IDs only (never typed text) → can never produce "@@"
function pingText(roleId, guildId) {
  if (!roleId) return '';
  return roleId === guildId ? '@everyone' : `<@&${roleId}>`;
}
function allowedMentions(roleId, guildId) {
  if (!roleId) return { parse: [] };
  return roleId === guildId ? { parse: ['everyone'] } : { parse: [], roles: [roleId] };
}

/* ───────────── Kick ───────────── */
let kickToken = { value: null, exp: 0 };
async function getKickToken() {
  if (kickToken.value && Date.now() < kickToken.exp) return kickToken.value;
  if (!env('KICK_CLIENT_ID') || !env('KICK_CLIENT_SECRET')) throw new Error('KICK_CLIENT_ID / KICK_CLIENT_SECRET not set');
  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: env('KICK_CLIENT_ID'), client_secret: env('KICK_CLIENT_SECRET'),
    }),
  });
  if (!res.ok) throw new Error(`Kick token request failed (${res.status})`);
  const j = await res.json();
  kickToken = { value: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  return kickToken.value;
}
// returns Map(slug → channel data)
async function kickFetch(slugs, retry = true) {
  const out = new Map();
  const token = await getKickToken();
  for (let i = 0; i < slugs.length; i += 50) {
    const qs = new URLSearchParams();
    slugs.slice(i, i + 50).forEach(s => qs.append('slug', s));
    const res = await fetch(`https://api.kick.com/public/v1/channels?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && retry) { kickToken.value = null; return kickFetch(slugs, false); }
    if (!res.ok) throw new Error(`Kick API ${res.status}`);
    for (const c of (await res.json()).data || []) out.set(String(c.slug).toLowerCase(), c);
  }
  return out;
}

/* ───────────── YouTube ───────────── */
async function ytApi(endpoint, params) {
  if (!env('YOUTUBE_API_KEY')) throw new Error('YOUTUBE_API_KEY not set');
  const qs = new URLSearchParams({ ...params, key: env('YOUTUBE_API_KEY') });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    throw new Error(`YouTube ${endpoint} ${res.status} ${msg}`.trim());
  }
  return res.json();
}
// accepts @handle, handle, channel URL (…/@name or …/channel/UC…), or a UC… channel ID
async function resolveYouTube(input) {
  const raw = input.trim();
  const id = raw.match(/UC[\w-]{22}/)?.[0];
  let params; let handle = null;
  if (id) params = { id };
  else {
    const h = raw.match(/@([\w.\-]+)/)?.[1] || raw.replace(/^@+/, '').split(/[/?#]/)[0];
    handle = '@' + h;
    params = { forHandle: handle };
  }
  const j = await ytApi('channels', { part: 'snippet', ...params });
  const c = j.items?.[0];
  if (!c) return null;
  return { channelId: c.id, display: c.snippet.title, avatar: c.snippet.thumbnails?.default?.url, handle };
}
// Several independent ways to find a channel's current/recent videos. Each only yields CANDIDATE IDs;
// the YouTube API (videos.list) is what finally confirms whether one is live.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function rssIds(cid) {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    return [...(await res.text()).matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map(m => m[1]).slice(0, 5);
  } catch { return []; }
}
// youtube.com/channel/UC…/live shows the live stream if there is one (free, no quota, not delayed like the feed)
async function livePageId(cid) {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${cid}/live`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!/"isLiveNow":true/.test(html)) return null;
    return html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1]
      || html.match(/"videoId":"([\w-]{11})"/)?.[1] || null;
  } catch { return null; }
}
async function playlistIds(cid) {
  try {
    const j = await ytApi('playlistItems', { part: 'contentDetails', playlistId: 'UU' + cid.slice(2), maxResults: '5' });
    return (j.items || []).map(i => i.contentDetails.videoId);
  } catch (e) { console.error('streams: YouTube playlist lookup failed:', e.message); return []; }
}
async function gatherCandidates(cid, usePlaylist) {
  const ids = new Set(); const src = [];
  const [rss, page] = await Promise.all([rssIds(cid), livePageId(cid)]);
  rss.forEach(x => ids.add(x)); src.push(`feed:${rss.length}`);
  if (page) ids.add(page); src.push(page ? 'live-page:LIVE' : 'live-page:no');
  if (usePlaylist) { const pl = await playlistIds(cid); pl.forEach(x => ids.add(x)); src.push(`uploads:${pl.length}`); }
  return { ids, src };
}
// deep=true (manual /youtuberecheck and /youtubeadd): if nothing else finds a live stream, ask YouTube search
// directly (definitive, but costs 100 quota units per channel, so never used by the 30s poll).
async function ytFetchLive(channelIds, { usePlaylist = true, deep = false } = {}) {
  const per = new Map();
  await Promise.all(channelIds.map(async cid => per.set(cid, await gatherCandidates(cid, usePlaylist || deep))));

  const items = new Map(); // videoId → video resource
  const fetchInfo = async ids => {
    for (let i = 0; i < ids.length; i += 50) {
      const j = await ytApi('videos', { part: 'snippet,liveStreamingDetails', id: ids.slice(i, i + 50).join(',') });
      for (const v of j.items || []) items.set(v.id, v);
    }
  };
  const live = new Map(); // ytChannelId → live video
  const collect = () => { for (const v of items.values()) if (v.snippet.liveBroadcastContent === 'live') live.set(v.snippet.channelId, v); };

  await fetchInfo([...new Set([...per.values()].flatMap(p => [...p.ids]))]);
  collect();

  if (deep) {
    const found = [];
    await Promise.all(channelIds.filter(c => !live.has(c)).map(async cid => {
      try {
        const j = await ytApi('search', { part: 'id', channelId: cid, eventType: 'live', type: 'video', maxResults: '1' });
        const id = j.items?.[0]?.id?.videoId;
        per.get(cid).src.push(id ? 'search:LIVE' : 'search:none');
        if (id) { per.get(cid).ids.add(id); found.push(id); }
      } catch (e) { per.get(cid).src.push(`search:error(${trunc(e.message, 70)})`); }
    }));
    if (found.length) { await fetchInfo(found); collect(); }
  }

  const debug = new Map();
  for (const cid of channelIds) {
    const p = per.get(cid);
    const vids = [...p.ids].map(id => items.get(id)).filter(v => v && v.snippet.channelId === cid).slice(0, 2)
      .map(v => `“${trunc(v.snippet.title, 40)}” (${v.snippet.liveBroadcastContent})`);
    debug.set(cid, `looked at ${p.src.join(' · ')}${vids.length ? ` — latest: ${vids.join(', ')}` : ' — no videos found for this channel ID'}`);
  }
  return { live, debug };
}

/* ───────────── announcement ───────────── */
async function announce(entry, info) {
  const channel = await client.channels.fetch(entry.discordChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('announcement channel not found (deleted or no access)');

  const p = NAMES[entry.platform];
  const embed = new EmbedBuilder()
    .setColor(COLORS[entry.platform])
    .setAuthor({ name: `${info.name} is LIVE on ${p}`, iconURL: info.avatar || undefined, url: info.url })
    .setTitle(trunc(info.title || 'Untitled stream', 256))
    .setURL(info.url)
    .setDescription(`🔴 **${info.name}** just went live — come hang out!`)
    .setTimestamp()
    .setFooter({ text: `${BRAND} • ${p} Live Alerts` });
  const fields = [];
  if (info.category) fields.push({ name: '🎮 Category', value: trunc(info.category, 100), inline: true });
  if (info.viewers != null) fields.push({ name: '👀 Viewers', value: String(info.viewers), inline: true });
  fields.push({ name: '📺 Platform', value: p, inline: true });
  embed.addFields(fields);
  if (info.image) embed.setImage(info.image);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Watch now').setEmoji('▶️').setStyle(ButtonStyle.Link).setURL(info.url),
  );
  const ping = pingText(entry.pingRoleId, entry.guildId);
  await channel.send({
    content: `${ping ? ping + ' ' : ''}🚨 **${info.name}** is live on **${p}**!`,
    embeds: [embed],
    components: [row],
    allowedMentions: allowedMentions(entry.pingRoleId, entry.guildId),
  });
}

/* ───────────── checking (shared by the 30s poll AND recheck) ───────────── */
// Announces ONLY on offline → live with a NEW stream key (or when force=true).
// If sending fails the state is rolled back, so the next check retries instead of silently skipping.
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
        console.error(`streams: announce failed for ${entry.display}:`, e.message);
        entry.live = prev.live;
        entry.lastKey = prev.lastKey;
        save();
        return { announced: false, error: e.message };
      }
    }
    if (!entry.live) { entry.live = true; save(); }
  } else if (entry.live) {
    entry.offlineStrikes = (entry.offlineStrikes || 0) + 1;
    if (entry.offlineStrikes >= OFFLINE_STRIKES_TO_RESET) {
      entry.live = false;
      if (String(entry.lastKey).startsWith('seen-')) entry.lastKey = null; // Kick sessions without a start_time
      save();
    }
  }
  return { announced: false };
}

let ytTick = 0;
// → { results: [{entry, live, announced, error, debug}], errors: [string] }
async function checkEntries(entries, force = false, deep = false) {
  const results = [];
  const errors = [];

  const kickEntries = entries.filter(e => e.platform === 'kick');
  if (kickEntries.length) {
    try {
      const data = await kickFetch([...new Set(kickEntries.map(e => e.username))]);
      for (const e of kickEntries) {
        const c = data.get(e.username);
        if (!c) { errors.push(`Kick: ${e.display} not found`); continue; }
        const s = c.stream;
        const isLive = !!s?.is_live;
        const key = isLive ? (s.start_time || (e.live && e.lastKey) || `seen-${Date.now()}`) : null;
        const st = await handleState(e, isLive, key, () => ({
          name: e.display,
          title: c.stream_title,
          category: c.category?.name,
          viewers: s.viewer_count,
          image: s.thumbnail ? `${s.thumbnail}${s.thumbnail.includes('?') ? '&' : '?'}t=${Date.now()}` : null,
          url: `https://kick.com/${e.username}`,
        }), force);
        results.push({ entry: e, live: isLive, ...st });
      }
    } catch (err) { errors.push(`Kick: ${err.message}`); }
  }

  const ytEntries = entries.filter(e => e.platform === 'youtube');
  if (ytEntries.length) {
    try {
      const cids = [...new Set(ytEntries.map(e => e.ytChannelId))];
      // uploads-playlist lookups cost quota every poll, so with many channels do them every 4th poll only
      const usePlaylist = cids.length <= 2 || (++ytTick % 4 === 0);
      const { live, debug } = await ytFetchLive(cids, { usePlaylist, deep });
      for (const e of ytEntries) {
        const v = live.get(e.ytChannelId);
        const st = await handleState(e, !!v, v?.id || null, () => ({
          name: e.display,
          title: v.snippet.title,
          viewers: v.liveStreamingDetails?.concurrentViewers,
          avatar: e.avatar,
          image: `https://i.ytimg.com/vi/${v.id}/maxresdefault_live.jpg?t=${Date.now()}`,
          url: `https://www.youtube.com/watch?v=${v.id}`,
        }), force);
        results.push({ entry: e, live: !!v, ...st, debug: debug.get(e.ytChannelId) });
      }
    } catch (err) { errors.push(`YouTube: ${err.message}`); }
  }
  return { results, errors };
}

// One check at a time: the 30s poll and manual rechecks can never overlap → no duplicate sends
let busy = false;
async function runExclusive(entries, force = false, deep = false) {
  while (busy) await sleep(300);
  busy = true;
  try { return await checkEntries(entries, force, deep); } finally { busy = false; }
}
async function poll() {
  if (busy) return;
  const active = db.filter(e => e.enabled);
  if (!active.length) return;
  const { errors } = await runExclusive(active);
  errors.forEach(e => console.error('streams poll:', e));
}

/* ───────────── slash commands ───────────── */
const manage = PermissionFlagsBits.ManageGuild;
const LABEL = { kick: 'Kick', youtube: 'YouTube' };
const HINT = { kick: 'Kick username or kick.com link', youtube: 'YouTube @handle, channel link or channel ID' };

function buildCommands() {
  const out = [];
  for (const p of ['kick', 'youtube']) {
    out.push(new SlashCommandBuilder().setName(`${p}add`)
      .setDescription(`Announce when a ${LABEL[p]} streamer goes live`)
      .setDefaultMemberPermissions(manage)
      .addStringOption(o => o.setName('user').setDescription(HINT[p]).setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Where to post the announcement')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addRoleOption(o => o.setName('ping').setDescription('Role to ping (optional, @everyone allowed)')));
    out.push(new SlashCommandBuilder().setName(`${p}remove`)
      .setDescription(`Stop tracking a ${LABEL[p]} streamer and delete them`)
      .setDefaultMemberPermissions(manage)
      .addStringOption(o => o.setName('user').setDescription('Streamer name').setRequired(true)));
    out.push(new SlashCommandBuilder().setName(`${p}disable`)
      .setDescription(`Pause alerts for a ${LABEL[p]} streamer (run /${p}add again to resume)`)
      .setDefaultMemberPermissions(manage)
      .addStringOption(o => o.setName('user').setDescription('Streamer name').setRequired(true)));
    out.push(new SlashCommandBuilder().setName(`${p}recheck`)
      .setDescription(`Check right now if ${LABEL[p]} streamers are live`)
      .setDefaultMemberPermissions(manage)
      .addStringOption(o => o.setName('user').setDescription('Streamer name (leave empty to check everyone)'))
      .addBooleanOption(o => o.setName('force').setDescription('Re-send the announcement even if already announced')));
    out.push(new SlashCommandBuilder().setName(`${p}list`)
      .setDescription(`Show tracked ${LABEL[p]} streamers`)
      .setDefaultMemberPermissions(manage));
  }
  return out.map(c => c.toJSON());
}
const commands = buildCommands();

function embed(color, title, text) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(text)
    .setTimestamp().setFooter({ text: `${BRAND} • Live Alerts` });
}
async function say(i, color, title, text, opts = {}) {
  const payload = { embeds: [embed(color, title, text)] };
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply({ ...payload, ephemeral: opts.ephemeral !== false });
}

async function findEntry(guildId, platform, input) {
  const list = db.filter(e => e.guildId === guildId && e.platform === platform);
  const n = norm(platform === 'kick' ? kickSlug(input) : input);
  const hit = list.find(e => norm(e.display) === n || norm(e.username) === n || (e.handle && norm(e.handle) === n));
  if (hit) return hit;
  if (platform === 'youtube') {
    const r = await resolveYouTube(input).catch(() => null);
    if (r) return list.find(e => e.username === r.channelId.toLowerCase()) || null;
  }
  return null;
}

function statusLine(r) {
  const name = `**${r.entry.display}**`;
  if (!r.live) return `⚫ ${name} — offline` + (r.debug ? `\n   ↳ ${r.debug}` : '');
  if (r.error) return `⚠️ ${name} — live, but the announcement FAILED: ${r.error}\n   ↳ Give the bot View Channel, Send Messages and Embed Links in <#${r.entry.discordChannelId}>`;
  return r.announced ? `🔴 ${name} — live · announcement sent` : `🔴 ${name} — live · already announced`;
}

// Returns true if the interaction was one of ours (so the main bot can stop processing it).
async function handle(i) {
  if (!i.isChatInputCommand()) return false;
  const m = i.commandName.match(/^(kick|youtube)(add|remove|disable|recheck|list)$/);
  if (!m) return false;
  const [, platform, action] = m;
  const p = NAMES[platform];

  try {
    if (!i.inGuild()) { await say(i, COLORS.err, '❌ Server only', 'Use this command inside a server.'); return true; }
    const perms = i.memberPermissions;
    if (!perms?.has(PermissionFlagsBits.Administrator) && !perms?.has(PermissionFlagsBits.ManageGuild)) {
      await say(i, COLORS.err, '❌ Permission denied', 'You need **Administrator** or **Manage Server**.');
      return true;
    }

    /* add */
    if (action === 'add') {
      await i.deferReply();
      const input = i.options.getString('user', true);
      const channel = i.options.getChannel('channel', true);
      const role = i.options.getRole('ping');
      const base = { platform, guildId: i.guildId, discordChannelId: channel.id, pingRoleId: role?.id || null, enabled: true };
      let fields;

      if (platform === 'kick') {
        const slug = kickSlug(input);
        if (!slug) return await say(i, COLORS.err, '❌ No username', 'Please enter a Kick username.'), true;
        const c = (await kickFetch([slug])).get(slug);
        if (!c) return await say(i, COLORS.err, '❌ Not found', `Couldn't find **${slug}** on Kick. Use the name from kick.com/**name**.`), true;
        fields = { username: slug, display: String(c.slug) };
      } else {
        const r = await resolveYouTube(input);
        if (!r) return await say(i, COLORS.err, '❌ Not found', "Couldn't find that YouTube channel. Use the **@handle**, channel link or channel ID (UC…)."), true;
        fields = { username: r.channelId.toLowerCase(), ytChannelId: r.channelId, display: r.display, avatar: r.avatar, handle: r.handle };
      }

      let entry = find(i.guildId, platform, fields.username);
      if (entry) Object.assign(entry, base, fields);                          // re-adding keeps the live/announced state → no repeat
      else { entry = { ...base, ...fields, live: false, lastKey: null, offlineStrikes: 0 }; db.push(entry); }
      save();

      // check right away: if they're live right now, the announcement goes out now
      const { results, errors } = await runExclusive([entry], false, true);
      const r0 = results[0];
      const ping = pingText(entry.pingRoleId, i.guildId) || 'no ping';
      let text = `**${entry.display}** is now tracked on ${p}\n📢 Channel: <#${channel.id}>\n🔔 Ping: ${ping}\n⏱️ Checked every 30 seconds`;
      text += `\n\n${r0 ? statusLine(r0) : `⚠️ ${errors[0] || 'Could not check right now — it will be retried automatically.'}`}`;
      await say(i, COLORS.ok, '✅ Streamer added', text);
      return true;
    }

    /* remove | disable */
    if (action === 'remove' || action === 'disable') {
      const input = i.options.getString('user', true);
      const entry = await findEntry(i.guildId, platform, input);
      if (!entry) { await say(i, COLORS.err, '❌ Not tracked', `**${input}** isn't being tracked on ${p}. Try \`/${platform}list\`.`); return true; }
      if (action === 'remove') {
        db = db.filter(e => e !== entry); save();
        await say(i, COLORS.ok, '🗑️ Removed', `**${entry.display}** was removed from ${p} alerts.`, { ephemeral: false });
      } else {
        entry.enabled = false; save();
        await say(i, COLORS.off, '⏸️ Disabled', `Alerts for **${entry.display}** on ${p} are paused.\nRun \`/${platform}add\` again to turn them back on.`, { ephemeral: false });
      }
      return true;
    }

    /* list */
    if (action === 'list') {
      const list = db.filter(e => e.guildId === i.guildId && e.platform === platform);
      if (!list.length) { await say(i, COLORS.off, `📺 ${p} streamers`, `Nobody added yet. Use \`/${platform}add\`.`); return true; }
      const lines = list.map(e => {
        const icon = !e.enabled ? '⏸️' : e.live ? '🔴' : '⚫';
        const ping = pingText(e.pingRoleId, e.guildId);
        return `${icon} **${e.display}** → <#${e.discordChannelId}>${ping ? ` · pings ${ping}` : ''}${e.enabled ? '' : ' · disabled'}`;
      });
      await say(i, COLORS[platform], `📺 ${p} streamers (${list.length})`, lines.join('\n'));
      return true;
    }

    /* recheck */
    if (action === 'recheck') {
      await i.deferReply({ ephemeral: true });
      const input = i.options.getString('user');
      const force = i.options.getBoolean('force') ?? false;
      let list = db.filter(e => e.guildId === i.guildId && e.platform === platform);
      if (input) {
        const entry = await findEntry(i.guildId, platform, input);
        if (!entry) return await say(i, COLORS.err, '❌ Not tracked', `**${input}** isn't being tracked on ${p}.`), true;
        list = [entry];
      }
      if (!list.length) { await say(i, COLORS.off, `${p} recheck`, `No ${p} streamers added yet. Use \`/${platform}add\` first.`); return true; }

      const paused = list.filter(e => !e.enabled);
      const { results, errors } = await runExclusive(list.filter(e => e.enabled), force, true);
      const lines = [
        ...results.map(statusLine),
        ...paused.map(e => `⏸️ **${e.display}** — disabled`),
        ...errors.map(e => `⚠️ ${e}`),
      ];
      await say(i, COLORS[platform], `${p} recheck${force ? ' (forced)' : ''}`,
        (lines.join('\n') || 'Nothing to check.') + `\n\n*${force ? 'Forced: re-sent for live streamers' : 'Only new streams get announced — no duplicates'}*`);
      return true;
    }
  } catch (err) {
    console.error('streams command error:', err);
    await say(i, COLORS.err, '⚠️ Something went wrong', err.message ? `\`${trunc(err.message, 300)}\`` : 'Please try again.').catch(() => {});
  }
  return true;
}

/* ───────────── lifecycle ───────────── */
function start(discordClient) {
  client = discordClient;
  if (!env('KICK_CLIENT_ID') || !env('KICK_CLIENT_SECRET')) console.warn('📺 streams: KICK_CLIENT_ID/KICK_CLIENT_SECRET not set — Kick alerts will fail.');
  if (!env('YOUTUBE_API_KEY')) console.warn('📺 streams: YOUTUBE_API_KEY not set — YouTube alerts will fail.');
  poll().catch(e => console.error('streams poll:', e));
  setInterval(() => poll().catch(e => console.error('streams poll:', e)), POLL_MS);
  console.log(`📺 streams: polling every ${POLL_MS / 1000}s · ${db.length} streamer(s) loaded from ${DB_FILE}`);
}
function forgetGuild(guildId) {
  const before = db.length;
  db = db.filter(e => e.guildId !== guildId);
  if (db.length !== before) save();
}

/* ───────────── bot startup ───────────── */
// Never die silently: always print the reason.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN is missing. Add it in Render → Environment, then redeploy.');
  process.exit(1);
}

// Health server first, so Render sees an open port right away.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('PURNIMA online'); })
  .listen(PORT, () => console.log(`🌐 Health server on port ${PORT}`));

client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function registerCommands(c) {
  try {
    await c.application.commands.set([]); // clear global copies so commands never show twice
    for (const guild of c.guilds.cache.values()) {
      await guild.commands.set(commands);
      console.log(`✅ Registered ${commands.length} commands in ${guild.name}`);
    }
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
}

client.once(Events.ClientReady, async c => {
  console.log(`✅ PURNIMA logged in as ${c.user.tag} (${c.guilds.cache.size} server(s))`);
  c.user.setPresence({ activities: [{ name: 'live streams | /kickadd', type: ActivityType.Watching }], status: 'online' });
  await registerCommands(c);
  start(c);
});

client.on(Events.InteractionCreate, i => { handle(i).catch(err => console.error('Interaction error:', err)); });
client.on(Events.GuildCreate, g => g.commands.set(commands).catch(console.error));
client.on(Events.GuildDelete, g => forgetGuild(g.id));
client.on('error', err => console.error('Discord client error:', err));

// ── connection diagnostics + watchdog (restarts the process if the Discord link stays dead) ──
client.on(Events.ShardDisconnect, (e, id) => console.warn(`⚠️ Shard ${id} disconnected (code ${e?.code})`));
client.on(Events.ShardReconnecting, id => console.warn(`🔄 Shard ${id} reconnecting…`));
client.on(Events.ShardResume, id => console.log(`✅ Shard ${id} resumed`));
client.on(Events.ShardError, (err, id) => console.error(`❌ Shard ${id} error:`, err.message));
let deadChecks = 0;
setInterval(() => {
  const ok = client.isReady() && client.ws.status === 0 && client.ws.ping >= 0;
  deadChecks = ok ? 0 : deadChecks + 1;
  if (deadChecks >= 3) { console.error('❌ Discord connection dead for ~3 min — exiting so Render restarts the bot'); process.exit(1); }
}, 60_000).unref();

console.log('🚀 Starting PURNIMA…');
client.login(TOKEN).catch(err => { console.error('❌ Discord login failed:', err.message); process.exit(1); });