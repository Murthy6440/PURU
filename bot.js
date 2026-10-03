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
    signal: AbortSignal.timeout(15000),
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
      signal: AbortSignal.timeout(15000),
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
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`, { signal: AbortSignal.timeout(15000) });
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
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    return [...(await res.text()).matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map(m => m[1]).slice(0, 5);
  } catch { return []; }
}
// youtube.com/channel/UC…/live shows the live stream if there is one (free, no quota, not delayed like the feed)
async function livePageId(cid) {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${cid}/live`, {
      signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
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
      await i.deferReply();
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

/* ───────────── bot avatar (this is the icon Discord shows in push notifications) ───────────── */
// Embedded so the bot stays a single file.
const AVATAR_B64 = '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';
async function setBotAvatar(c) {
  // One-time: add env SET_AVATAR=1 on Render, deploy once, then delete the variable.
  // (Render's disk resets, and Discord rate-limits avatar changes, so it must not run on every start.)
  if (env('SET_AVATAR') !== '1') return;
  try {
    await c.user.setAvatar(Buffer.from(AVATAR_B64, 'base64'));
    console.log('🖼️ Bot avatar updated — you can delete the SET_AVATAR variable now');
  } catch (err) {
    console.warn('⚠️ Could not set bot avatar:', err.message);
  }
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
  setBotAvatar(c); // not awaited: must never delay polling or commands
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