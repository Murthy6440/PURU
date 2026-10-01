require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  MessageFlags,
  Events
} = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===============================
// ENVIRONMENT VARIABLES
// ===============================
// Required:  DISCORD_TOKEN
// Kick:      KICK_CLIENT_ID, KICK_CLIENT_SECRET
// YouTube:   YOUTUBE_API_KEY
// Optional:  DATA_DIR                 folder for state.json (use a persistent disk, e.g. /data)
//            KICK_USERNAME            default Kick streamer given to newly set-up servers
//            YOUTUBE_CHANNEL_ID       default YouTube channel (UC...) given to newly set-up servers
//            ANNOUNCEMENT_CHANNEL_ID / ANNOUNCEMENT_ROLE_ID   auto-configure one server
//            REPEAT_MINUTES (60), REPEAT_PING (true), YOUTUBE_INTERVAL_SECONDS (120),
//            MAX_STREAMERS_PER_PLATFORM (10), ENABLE_KICK_COMMAND, ENABLE_YOUTUBE_COMMAND
// Streamers, channel, role and platform on/off are managed per server with slash commands.

const {
  DISCORD_TOKEN,
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  YOUTUBE_API_KEY,
  KICK_USERNAME,
  YOUTUBE_CHANNEL_ID
} = process.env;

if (!DISCORD_TOKEN) {
  console.error("Missing required env var: DISCORD_TOKEN");
  process.exit(1);
}

const KICK_ENABLED = Boolean(KICK_CLIENT_ID && KICK_CLIENT_SECRET);
const YOUTUBE_ENABLED = Boolean(YOUTUBE_API_KEY);

if (!KICK_ENABLED) console.warn("[Kick] Disabled globally (missing KICK_CLIENT_ID / KICK_CLIENT_SECRET)");
if (!YOUTUBE_ENABLED) console.warn("[YouTube] Disabled globally (missing YOUTUBE_API_KEY)");

const PLATFORM_NAMES = { kick: "Kick", youtube: "YouTube" };

const CHECK_INTERVAL = 30 * 1000;
const FETCH_TIMEOUT = 10 * 1000;
const OFFLINE_RESET_MS = 10 * 60 * 1000; // offline this long = next live is a new broadcast
const PING_COOLDOWN_MS = 15 * 60 * 1000; // max one role ping per server per window
const MANUAL_RECHECK_COOLDOWN_MS = 10 * 1000;

// YouTube quota: each check costs (channels + 1) units out of 10,000/day, so it polls slower than Kick.
const YOUTUBE_INTERVAL_MS = Math.max(30, parseInt(process.env.YOUTUBE_INTERVAL_SECONDS || "120", 10) || 120) * 1000;
const MAX_STREAMERS_PER_PLATFORM = Math.max(1, parseInt(process.env.MAX_STREAMERS_PER_PLATFORM || "10", 10) || 10);

const ENABLE_KICK_COMMAND = process.env.ENABLE_KICK_COMMAND !== "false";
const ENABLE_YOUTUBE_COMMAND = process.env.ENABLE_YOUTUBE_COMMAND !== "false";

// While a stream is live, re-post the announcement every N minutes (0 = never repeat).
const MIN_REPEAT_MINUTES = 15;
const parsedRepeat = parseInt(process.env.REPEAT_MINUTES ?? "60", 10);
const DEFAULT_REPEAT_MINUTES =
  Number.isFinite(parsedRepeat) && parsedRepeat > 0 ? Math.max(parsedRepeat, MIN_REPEAT_MINUTES) : 0;
const REPEAT_PING = process.env.REPEAT_PING !== "false";

function getRepeatMs(config) {
  const minutes = config.repeatMinutes ?? DEFAULT_REPEAT_MINUTES;
  return minutes > 0 ? minutes * 60 * 1000 : 0;
}

function normalizeMentionRoleId(value) {
  if (!value) return null;
  const id = String(value).trim().replace(/^<@&?|>|@/g, "").trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

// ===============================
// KEEP-ALIVE HTTP SERVER (Render "Web Service" needs an open port)
// ===============================

if (process.env.PORT) {
  http
    .createServer((req, res) => res.end("ok"))
    .listen(process.env.PORT, () => console.log(`HTTP keep-alive on port ${process.env.PORT}`));
}

// ===============================
// SINGLE-INSTANCE LOCK
// ===============================

const LOCK_FILE = path.join(__dirname, "bot.lock");

function acquireLock() {
  try {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        console.error(`Another instance is already running (pid ${oldPid}). Stop it or delete bot.lock.`);
        process.exit(1);
      } catch (e) {
        if (e.code === "EPERM") {
          console.error(`Another instance appears to be running (pid ${oldPid}).`);
          process.exit(1);
        }
      }
    }
  } catch {}
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {}
  const release = () => {
    try {
      if (parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10) === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {}
  };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

acquireLock();

// ===============================
// STATE (persisted)
// ===============================
// state.guilds[guildId] = {
//   channelId, roleId, repeatMinutes, lastPingAt,
//   kickEnabled, youtubeEnabled,
//   streamers: [{ platform, id, label, announced, lastAt }]
// }
// state.live["kick:slug"] = { lastLive }

const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {}
const STATE_FILE = path.join(DATA_DIR, "state.json");

const state = { guilds: {}, live: {} };

function makeStreamer(platform, id, label) {
  return { platform, id, label: label || id, announced: false, lastAt: 0 };
}

// Streamers from the env vars, given to servers that have none configured
function defaultStreamers() {
  const list = [];
  if (KICK_USERNAME) list.push(makeStreamer("kick", KICK_USERNAME.trim().toLowerCase(), KICK_USERNAME.trim()));
  if (YOUTUBE_CHANNEL_ID && /^UC[\w-]{22}$/.test(YOUTUBE_CHANNEL_ID.trim())) {
    list.push(makeStreamer("youtube", YOUTUBE_CHANNEL_ID.trim(), "YouTube channel"));
  }
  return list;
}

function newGuildConfig(channelId, roleId) {
  return {
    channelId,
    roleId: roleId || null,
    repeatMinutes: null, // null = use REPEAT_MINUTES default
    lastPingAt: 0,
    kickEnabled: true,
    youtubeEnabled: true,
    streamers: defaultStreamers()
  };
}

// Upgrade configs saved by older versions (single streamer from env vars)
function normalizeGuild(g) {
  if (!Array.isArray(g.streamers)) {
    g.streamers = defaultStreamers().map(s => {
      s.announced = Boolean(g[`${s.platform}Announced`]);
      s.lastAt = g[`${s.platform}LastAt`] || 0;
      return s;
    });
  }
  for (const k of ["kickAnnounced", "youtubeAnnounced", "kickLastAt", "youtubeLastAt"]) delete g[k];
  g.kickEnabled ??= true;
  g.youtubeEnabled ??= true;
  g.repeatMinutes ??= null;
  g.lastPingAt ??= 0;
  g.roleId ??= null;
  return g;
}

try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  Object.assign(state.guilds, saved.guilds);
  Object.assign(state.live, saved.live);
  for (const g of Object.values(state.guilds)) normalizeGuild(g);
} catch {
  console.warn(`No saved state at ${STATE_FILE} (first run, or the disk was wiped).`);
}

function saveState() {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("Failed to save state:", e.message);
  }
}

function platformOn(config, platform) {
  const globallyOn = platform === "kick" ? KICK_ENABLED : YOUTUBE_ENABLED;
  return globallyOn && config[`${platform}Enabled`] !== false;
}

// ===============================
// HELPERS
// ===============================

async function fetchTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
}

// Survives restarts and a wiped state.json: look at what the bot already posted in
// the channel and see whether it covers THIS broadcast. `since` is the broadcast start.
async function findPosted(channel, pending) {
  const posted = new Map(); // key -> newest matching post timestamp
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    for (const m of messages.values()) {
      if (m.author.id !== client.user.id) continue;
      for (const p of pending) {
        if (m.createdTimestamp >= p.since && m.embeds.some(e => e.url === p.url)) {
          posted.set(p.key, Math.max(posted.get(p.key) || 0, m.createdTimestamp));
        }
      }
    }
  } catch {
    // missing Read Message History permission etc.: fall back to saved state only
  }
  return posted;
}

// ===============================
// KICK
// ===============================

let kickToken = null;
let kickTokenExpiresAt = 0;

async function getKickToken() {
  if (kickToken && Date.now() < kickTokenExpiresAt) return kickToken;

  const response = await fetchTimeout("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET
    })
  });

  if (!response.ok) throw new Error(`Kick token error: ${response.status}`);

  const data = await response.json();
  kickToken = data.access_token;
  kickTokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return kickToken;
}

// One request for many streamers (the API accepts up to 50 slugs). Returns Map<slug, channel>.
async function getKickChannels(slugs) {
  const result = new Map();
  if (!slugs.length) return result;

  const token = await getKickToken();

  for (let i = 0; i < slugs.length; i += 50) {
    const qs = slugs
      .slice(i, i + 50)
      .map(s => `slug=${encodeURIComponent(s)}`)
      .join("&");

    const response = await fetchTimeout(`https://api.kick.com/public/v1/channels?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });

    if (response.status === 401) {
      kickToken = null;
      throw new Error("Kick API error: 401 (token reset)");
    }
    if (!response.ok) throw new Error(`Kick API error: ${response.status}`);

    const data = await response.json();
    for (const ch of data.data || []) result.set(String(ch.slug).toLowerCase(), ch);
  }

  return result;
}

function normalizeKickInput(input) {
  let v = String(input).trim();
  const m = v.match(/kick\.com\/([^/?#\s]+)/i);
  if (m) v = m[1];
  return v.replace(/^@/, "").toLowerCase();
}

function buildKickAnnouncement(channel) {
  const stream = channel.stream || {};
  const name = channel.slug;
  const title = channel.stream_title || `${name} is Live!`;
  const category = channel.category?.name || "Live Stream";
  const viewers = stream.viewer_count ?? 0;
  const thumbnail = stream.thumbnail || channel.banner_picture || null;
  const url = `https://kick.com/${channel.slug}`;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${name} is LIVE on Kick` })
    .setTitle(title.slice(0, 256))
    .setURL(url)
    .setDescription(
      `🔴 **${name} is now live!**\n\n` +
        `🎮 **Category:** ${category}\n` +
        `👥 **Viewers:** ${viewers}`
    )
    .setTimestamp()
    .setFooter({ text: "Kick Live Notification" });

  if (thumbnail) embed.setImage(thumbnail);

  // Broadcast start (minus slack). Without start_time, assume the last 6 hours.
  const start = Date.parse(stream.start_time);
  const since = Number.isFinite(start) ? start - 2 * 60 * 1000 : Date.now() - 6 * 60 * 60 * 1000;

  return { platform: "kick", name, title, url, embed, since };
}

// ===============================
// YOUTUBE
// ===============================
// Cost per check: 1 unit per channel (uploads playlist) + 1 unit per 50 videos.
// (search.list would cost 100 units per call and burn the daily quota within minutes.)

async function ytGet(endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: YOUTUBE_API_KEY });
  const response = await fetchTimeout(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
  if (!response.ok) throw new Error(`YouTube ${endpoint} API error: ${response.status}`);
  return response.json();
}

// Accepts a channel ID (UC...), a channel URL, an @handle, or a handle URL
async function resolveYouTubeChannel(input) {
  const v = String(input).trim();
  let params;

  const idMatch = v.match(/(UC[\w-]{22})/);
  const handleMatch = v.match(/youtube\.com\/(@[\w.-]+)/i) || v.match(/^(@[\w.-]+)$/);

  if (idMatch && (v === idMatch[1] || /youtube\.com\/channel\//i.test(v))) {
    params = { part: "snippet", id: idMatch[1] };
  } else if (handleMatch) {
    params = { part: "snippet", forHandle: handleMatch[1] };
  } else if (/^[\w.-]+$/.test(v)) {
    params = { part: "snippet", forHandle: "@" + v };
  } else {
    return null;
  }

  const data = await ytGet("channels", params);
  const item = data.items?.[0];
  return item ? { id: item.id, title: item.snippet?.title || item.id } : null;
}

// Returns Map<channelId, { live, video }>. A channel that failed to check is left out (= unknown).
async function getYouTubeStatuses(channelIds) {
  const out = new Map();
  if (!channelIds.length) return out;

  const videoIdsByChannel = new Map();

  await Promise.all(
    channelIds.map(async id => {
      try {
        const pl = await ytGet("playlistItems", {
          part: "contentDetails",
          maxResults: "10",
          playlistId: "UU" + id.slice(2)
        });
        videoIdsByChannel.set(
          id,
          (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean)
        );
      } catch (e) {
        console.error(`[YouTube] ${id}: ${e.message}`);
      }
    })
  );

  const allIds = [...new Set([...videoIdsByChannel.values()].flat())];
  const liveByChannel = new Map();

  for (let i = 0; i < allIds.length; i += 50) {
    const v = await ytGet("videos", { part: "snippet", id: allIds.slice(i, i + 50).join(",") });
    for (const item of v.items || []) {
      if (item.snippet?.liveBroadcastContent === "live" && !liveByChannel.has(item.snippet.channelId)) {
        liveByChannel.set(item.snippet.channelId, item);
      }
    }
  }

  for (const id of videoIdsByChannel.keys()) {
    out.set(id, { live: liveByChannel.has(id), video: liveByChannel.get(id) || null });
  }
  return out;
}

function buildYouTubeAnnouncement(video) {
  const snippet = video.snippet;
  const name = snippet.channelTitle;
  const title = snippet.title || "YouTube Live Stream";
  const url = `https://www.youtube.com/watch?v=${video.id}`;
  const thumbnail =
    snippet.thumbnails?.maxres?.url ||
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${name} is LIVE on YouTube` })
    .setTitle(title.slice(0, 256))
    .setURL(url)
    .setDescription(`🔴 **${name} is now live!**\n\n📺 **Watch the stream on YouTube**`)
    .setTimestamp()
    .setFooter({ text: "YouTube Live Notification" });

  if (thumbnail) embed.setImage(thumbnail);

  // The URL contains the unique video ID, so any earlier post of it is the same stream
  return { platform: "youtube", name, title, url, embed, since: 0 };
}

// ===============================
// ANNOUNCE TO ONE SERVER
// ===============================

async function announceToGuild(guildId, config, pending) {
  let channel;
  try {
    channel = await client.channels.fetch(config.channelId);
  } catch (error) {
    if (error.code === 10003 || error.code === 10004) {
      console.warn(`[${guildId}] Channel no longer exists, removing server config`);
      delete state.guilds[guildId];
      return;
    }
    throw error;
  }

  if (!channel || !channel.isTextBased() || typeof channel.send !== "function") {
    throw new Error("Configured channel is not a text channel");
  }

  // First announcement of a broadcast: check the channel history so a restart doesn't
  // announce it again. Repeats skip this check on purpose.
  const fresh = pending.filter(p => !p.isRepeat);
  if (fresh.length) {
    const posted = await findPosted(channel, fresh);
    for (const [key, ts] of posted) {
      const p = fresh.find(x => x.key === key);
      p.streamer.announced = true;
      p.streamer.lastAt = Math.max(p.streamer.lastAt || 0, ts);
    }
    pending = pending.filter(p => p.isRepeat || !posted.has(p.key));
  }

  if (!pending.length) {
    console.log(`[${guildId}] Nothing new to announce`);
    return;
  }

  const now = Date.now();
  const allRepeat = pending.every(p => p.isRepeat);
  const pingAllowed = !allRepeat || REPEAT_PING;
  const shouldPing = pingAllowed && config.roleId && now - config.lastPingAt > PING_COOLDOWN_MS;
  const mention = shouldPing ? `<@&${config.roleId}> ` : "";
  const prefix = allRepeat ? "🔁 Still live! " : "";
  const headline =
    pending.length === 1
      ? pending[0].title
      : `${pending.map(p => p.name).join(", ")} ${pending.length > 1 ? "are" : "is"} live!`;

  // Discord allows 10 embeds per message
  for (let i = 0; i < pending.length; i += 10) {
    const chunk = pending.slice(i, i + 10);

    await channel.send({
      content: i === 0 ? `${mention}${prefix}${headline}`.slice(0, 2000) : undefined,
      embeds: chunk.map(p => p.embed),
      allowedMentions: { roles: i === 0 && shouldPing ? [config.roleId] : [] }
    });

    const t = Date.now();
    for (const p of chunk) {
      p.streamer.announced = true;
      p.streamer.lastAt = t;
    }
    if (i === 0 && shouldPing) config.lastPingAt = now;
  }

  console.log(`[${guildId}] Announcement sent: ${pending.map(p => p.key).join(", ")}`);
}

// ===============================
// RECHECK
// ===============================

let checking = false;
let lastManualRecheck = 0;
let ytCache = new Map();
let ytCacheAt = 0;

async function recheck(force = false) {
  if (checking) {
    console.log("Previous check still running, skipping");
    return;
  }
  checking = true;

  try {
    const now = Date.now();

    // Unique streamers needed by at least one server that has that platform switched on
    const kickSlugs = new Set();
    const ytIds = new Set();
    for (const g of Object.values(state.guilds)) {
      if (!g.channelId) continue;
      for (const s of g.streamers) {
        if (!platformOn(g, s.platform)) continue;
        (s.platform === "kick" ? kickSlugs : ytIds).add(s.id);
      }
    }

    if (!kickSlugs.size && !ytIds.size) return;
    console.log(`Checking ${kickSlugs.size} Kick + ${ytIds.size} YouTube streamers...`);

    const statuses = new Map(); // key -> { live, build }

    if (kickSlugs.size) {
      try {
        const channels = await getKickChannels([...kickSlugs]);
        for (const slug of kickSlugs) {
          const ch = channels.get(slug);
          if (!ch) {
            console.warn(`[Kick] Channel not found: ${slug}`);
            continue; // unknown: leave state untouched
          }
          const live = ch.stream?.is_live === true;
          console.log(`[Kick] ${slug}: ${live ? "LIVE" : "OFFLINE"}`);
          statuses.set(`kick:${slug}`, { live, build: () => buildKickAnnouncement(ch) });
        }
      } catch (error) {
        console.error("[Kick] Error:", error.message);
      }
    }

    if (ytIds.size) {
      if (force || now - ytCacheAt >= YOUTUBE_INTERVAL_MS) {
        try {
          ytCache = await getYouTubeStatuses([...ytIds]);
          ytCacheAt = now;
        } catch (error) {
          console.error("[YouTube] Error:", error.message);
        }
      }
      for (const id of ytIds) {
        const st = ytCache.get(id);
        if (!st) continue;
        console.log(`[YouTube] ${id}: ${st.live ? "LIVE" : "OFFLINE"}`);
        statuses.set(`youtube:${id}`, { live: st.live, build: () => buildYouTubeAnnouncement(st.video) });
      }
    }

    // Track live/offline per streamer; offline long enough = next stream is announced afresh
    for (const [key, st] of statuses) {
      state.live[key] ??= { lastLive: 0 };
      if (st.live) {
        state.live[key].lastLive = now;
      } else if (now - state.live[key].lastLive > OFFLINE_RESET_MS) {
        for (const g of Object.values(state.guilds)) {
          for (const s of g.streamers) if (`${s.platform}:${s.id}` === key) s.announced = false;
        }
      }
    }

    // Build each live announcement once, share it across servers
    const payloads = new Map();
    const payloadFor = key => {
      if (!payloads.has(key)) payloads.set(key, statuses.get(key).build());
      return payloads.get(key);
    };

    for (const [guildId, config] of Object.entries(state.guilds)) {
      if (!config.channelId) continue;
      const repeatMs = getRepeatMs(config);
      const pending = [];

      for (const s of config.streamers) {
        if (!platformOn(config, s.platform)) continue;
        const key = `${s.platform}:${s.id}`;
        if (!statuses.get(key)?.live) continue;

        if (!s.announced) {
          pending.push({ ...payloadFor(key), key, streamer: s, isRepeat: false });
        } else {
          // Missing timestamp (older saved state): start the repeat clock now
          const lastAt = s.lastAt || (s.lastAt = now);
          if (repeatMs > 0 && now - lastAt >= repeatMs) {
            pending.push({ ...payloadFor(key), key, streamer: s, isRepeat: true });
          }
        }
      }

      if (!pending.length) continue;

      try {
        await announceToGuild(guildId, config, pending);
      } catch (error) {
        // other servers still get theirs; this one retries next check
        console.error(`[${guildId}] Announcement failed (will retry):`, error.message);
      }
    }

    saveState();
  } finally {
    checking = false;
  }
}

// ===============================
// SLASH COMMANDS
// ===============================

const platformChoices = [
  { name: "Kick", value: "kick" },
  { name: "YouTube", value: "youtube" }
];

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Choose where live announcements are posted in this server")
    .addChannelOption(o =>
      o
        .setName("channel")
        .setDescription("Channel for live announcements")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .addRoleOption(o => o.setName("role").setDescription("Role to ping (optional)"))
    .addIntegerOption(o =>
      o
        .setName("repeat_minutes")
        .setDescription("Re-post the announcement every N minutes while live (0 = never, min 15)")
        .setMinValue(0)
        .setMaxValue(1440)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("streamer")
    .setDescription("Manage which Kick and YouTube streamers are announced in this server")
    .addSubcommand(s =>
      s
        .setName("add")
        .setDescription("Add a streamer")
        .addStringOption(o =>
          o.setName("platform").setDescription("Platform").setRequired(true).addChoices(...platformChoices)
        )
        .addStringOption(o =>
          o
            .setName("account")
            .setDescription("Kick username, or YouTube @handle / channel ID / channel URL")
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s
        .setName("remove")
        .setDescription("Remove a streamer")
        .addStringOption(o =>
          o.setName("platform").setDescription("Platform").setRequired(true).addChoices(...platformChoices)
        )
        .addStringOption(o =>
          o.setName("account").setDescription("Username or channel name as shown in /streamer list").setRequired(true)
        )
    )
    .addSubcommand(s => s.setName("list").setDescription("Show the streamers announced in this server"))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("platform")
    .setDescription("Turn Kick or YouTube announcements on or off in this server")
    .addStringOption(o =>
      o.setName("platform").setDescription("Platform").setRequired(true).addChoices(...platformChoices)
    )
    .addBooleanOption(o => o.setName("enabled").setDescription("On or off").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Stop all live announcements in this server and delete its settings")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("recheck")
    .setDescription("Immediately check Kick and YouTube live status")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  ENABLE_KICK_COMMAND
    ? new SlashCommandBuilder().setName("kick").setDescription("Check which Kick streamers are live")
    : null,

  ENABLE_YOUTUBE_COMMAND
    ? new SlashCommandBuilder().setName("youtube").setDescription("Check which YouTube streamers are live")
    : null
]
  .filter(Boolean)
  .map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

// Per-server registration shows up in Discord instantly (global commands can lag)
async function registerGuildCommands(guild) {
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    console.log(
      `Slash commands registered in ${guild.name} (${guild.id}): ${commands.map(c => "/" + c.name).join(", ")}`
    );
  } catch (error) {
    if (error.code === 50001) {
      console.error(
        `[${guild.name}] Missing Access: the bot was invited without the applications.commands scope. Re-invite it using the link with scope=bot%20applications.commands.`
      );
    } else {
      console.error(`[${guild.name}] Failed to register slash commands:`, error.message);
    }
  }
}

async function registerCommands() {
  // Remove global commands from older versions so nothing shows up twice
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    console.log("Cleared old global commands");
  } catch (error) {
    console.error("Failed to clear global commands:", error.message);
  }

  for (const guild of client.guilds.cache.values()) {
    await registerGuildCommands(guild);
  }
}

// ===============================
// READY / GUILD EVENTS
// ===============================

let started = false;

client.once(Events.ClientReady, async () => {
  if (started) return;
  started = true;

  console.log(`Logged in as ${client.user.tag} (in ${client.guilds.cache.size} servers)`);

  await registerCommands();

  // Optional: auto-configure one server from env vars
  if (process.env.ANNOUNCEMENT_CHANNEL_ID) {
    try {
      const ch = await client.channels.fetch(process.env.ANNOUNCEMENT_CHANNEL_ID);
      if (ch?.guildId && !state.guilds[ch.guildId]) {
        state.guilds[ch.guildId] = newGuildConfig(
          ch.id,
          normalizeMentionRoleId(process.env.ANNOUNCEMENT_ROLE_ID)
        );
        saveState();
        console.log(`Auto-configured ${ch.guild.name} from environment variables`);
      }
    } catch (e) {
      console.error("ANNOUNCEMENT_CHANNEL_ID could not be used:", e.message);
    }
  }

  await recheck();
  setInterval(recheck, CHECK_INTERVAL);

  console.log("Live checker started (Kick every 30s, YouTube every " + YOUTUBE_INTERVAL_MS / 1000 + "s)");
});

client.on(Events.GuildCreate, guild => {
  console.log(`Joined server ${guild.name} (${guild.id})`);
  registerGuildCommands(guild);
});

client.on(Events.GuildDelete, guild => {
  if (guild.available === false) return; // outage, not a real removal
  if (state.guilds[guild.id]) {
    delete state.guilds[guild.id];
    saveState();
    console.log(`Removed config for ${guild.id}`);
  }
});

// ===============================
// COMMAND HANDLERS
// ===============================

const ephemeral = { flags: MessageFlags.Ephemeral };
const noMentions = { parse: [] };

async function handleSetup(interaction) {
  const channel = interaction.options.getChannel("channel", true);
  const role = interaction.options.getRole("role");
  const me = interaction.guild.members.me;

  const perms = channel.permissionsFor(me);
  const missing = ["ViewChannel", "SendMessages", "EmbedLinks"].filter(
    p => !perms?.has(PermissionsBitField.Flags[p])
  );

  if (missing.length) {
    return interaction.reply({
      content: `❌ I'm missing these permissions in ${channel}: **${missing.join(", ")}**. Fix that and run /setup again.`,
      ...ephemeral
    });
  }

  const repeatOpt = interaction.options.getInteger("repeat_minutes");
  const existing = state.guilds[interaction.guildId];

  let config;
  if (existing) {
    config = existing;
    config.channelId = channel.id;
    config.roleId = role?.id || null;
  } else {
    config = newGuildConfig(channel.id, role?.id);
    state.guilds[interaction.guildId] = config;
  }
  if (repeatOpt !== null) config.repeatMinutes = repeatOpt === 0 ? 0 : Math.max(repeatOpt, MIN_REPEAT_MINUTES);
  saveState();

  const repeat = config.repeatMinutes ?? DEFAULT_REPEAT_MINUTES;
  const notes = [];

  if (role && !role.mentionable && !me.permissions.has(PermissionsBitField.Flags.MentionEveryone)) {
    notes.push(
      "⚠️ That role isn't mentionable and I lack the **Mention Everyone** permission, so the ping won't work. Make the role mentionable or grant me that permission."
    );
  }
  if (!perms.has(PermissionsBitField.Flags.ReadMessageHistory)) {
    notes.push(
      "⚠️ I can't read message history in that channel. Grant **Read Message History**, otherwise a bot restart can cause a repeated announcement."
    );
  }
  if (!config.streamers.length) {
    notes.push("➡️ No streamers yet. Add some with `/streamer add`.");
  }

  await interaction.reply({
    content:
      `✅ Live announcements will be posted in ${channel}` +
      (role ? ` and ping ${role}.` : " with no role ping.") +
      (repeat > 0 ? ` While live, it re-posts every ${repeat} minutes.` : " It won't repeat while live.") +
      (notes.length ? "\n" + notes.join("\n") : ""),
    ...ephemeral,
    allowedMentions: noMentions
  });
}

async function handleRemove(interaction) {
  if (!state.guilds[interaction.guildId]) {
    return interaction.reply({ content: "This server isn't set up yet. Use /setup first.", ...ephemeral });
  }
  delete state.guilds[interaction.guildId];
  saveState();
  await interaction.reply({ content: "✅ Live announcements disabled and settings deleted for this server.", ...ephemeral });
}

function streamerLink(s) {
  return s.platform === "kick"
    ? `https://kick.com/${s.id}`
    : `https://www.youtube.com/channel/${s.id}`;
}

async function handleStreamer(interaction) {
  const config = state.guilds[interaction.guildId];
  if (!config) {
    return interaction.reply({ content: "Run /setup first to choose an announcement channel.", ...ephemeral });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    const lines = [];
    for (const platform of ["kick", "youtube"]) {
      const list = config.streamers.filter(s => s.platform === platform);
      let status = config[`${platform}Enabled`] === false ? "off" : "on";
      if (!(platform === "kick" ? KICK_ENABLED : YOUTUBE_ENABLED)) status = "not configured on this bot";
      lines.push(`**${PLATFORM_NAMES[platform]}** (${status})`);
      lines.push(...(list.length ? list.map(s => `• [${s.label}](${streamerLink(s)})`) : ["• none"]));
    }
    return interaction.reply({ content: lines.join("\n"), ...ephemeral, allowedMentions: noMentions });
  }

  const platform = interaction.options.getString("platform", true);
  const account = interaction.options.getString("account", true);

  if (sub === "remove") {
    const q = account.trim().toLowerCase();
    const kickQ = normalizeKickInput(account);
    const idx = config.streamers.findIndex(
      s =>
        s.platform === platform &&
        (s.id.toLowerCase() === q || s.label.toLowerCase() === q || (platform === "kick" && s.id === kickQ))
    );
    if (idx === -1) {
      return interaction.reply({
        content: "I couldn't find that streamer. Check the exact name with `/streamer list`.",
        ...ephemeral
      });
    }
    const [removed] = config.streamers.splice(idx, 1);
    saveState();
    return interaction.reply({
      content: `✅ Removed **${removed.label}** (${PLATFORM_NAMES[platform]}).`,
      ...ephemeral,
      allowedMentions: noMentions
    });
  }

  // add
  if (!(platform === "kick" ? KICK_ENABLED : YOUTUBE_ENABLED)) {
    return interaction.reply({
      content: `❌ ${PLATFORM_NAMES[platform]} isn't configured on this bot (missing API credentials).`,
      ...ephemeral
    });
  }

  if (config.streamers.filter(s => s.platform === platform).length >= MAX_STREAMERS_PER_PLATFORM) {
    return interaction.reply({
      content: `❌ Limit reached: at most ${MAX_STREAMERS_PER_PLATFORM} ${PLATFORM_NAMES[platform]} streamers per server.`,
      ...ephemeral
    });
  }

  await interaction.deferReply(ephemeral);

  try {
    let streamer;

    if (platform === "kick") {
      const slug = normalizeKickInput(account);
      if (!slug) return await interaction.editReply("❌ Please enter a Kick username.");
      const found = await getKickChannels([slug]);
      const ch = found.get(slug) || [...found.values()][0]; // API may normalise the slug
      if (!ch) return await interaction.editReply(`❌ I couldn't find a Kick channel called **${slug}**.`);
      streamer = makeStreamer("kick", String(ch.slug).toLowerCase(), ch.slug);
    } else {
      const ch = await resolveYouTubeChannel(account);
      if (!ch) {
        return await interaction.editReply(
          "❌ I couldn't find that YouTube channel. Use an @handle, a channel URL, or a channel ID starting with UC."
        );
      }
      streamer = makeStreamer("youtube", ch.id, ch.title);
    }

    if (config.streamers.some(s => s.platform === platform && s.id === streamer.id)) {
      return await interaction.editReply(`**${streamer.label}** is already in the list.`);
    }

    config.streamers.push(streamer);
    ytCacheAt = 0; // make the next check include the new YouTube channel straight away
    saveState();

    const extra = config[`${platform}Enabled`] === false
      ? `\n⚠️ ${PLATFORM_NAMES[platform]} announcements are switched off here. Turn them on with \`/platform\`.`
      : "\nIf they're live right now, the announcement will be posted within a minute or two.";

    await interaction.editReply({
      content: `✅ Added **${streamer.label}** (${PLATFORM_NAMES[platform]}).${extra}`,
      allowedMentions: noMentions
    });
  } catch (error) {
    console.error(`[${platform}] Add streamer error:`, error.message);
    await interaction.editReply("❌ Couldn't look that up right now. Try again in a moment.");
  }
}

async function handlePlatform(interaction) {
  const config = state.guilds[interaction.guildId];
  if (!config) {
    return interaction.reply({ content: "Run /setup first to choose an announcement channel.", ...ephemeral });
  }

  const platform = interaction.options.getString("platform", true);
  const enabled = interaction.options.getBoolean("enabled", true);

  config[`${platform}Enabled`] = enabled;
  saveState();

  const notConfigured = !(platform === "kick" ? KICK_ENABLED : YOUTUBE_ENABLED);

  await interaction.reply({
    content:
      `✅ ${PLATFORM_NAMES[platform]} announcements are now **${enabled ? "on" : "off"}** in this server.` +
      (enabled && notConfigured
        ? `\n⚠️ This bot has no ${PLATFORM_NAMES[platform]} API credentials, so nothing will be announced until they're added.`
        : ""),
    ...ephemeral
  });
}

// /kick and /youtube: who is live right now (this server's streamers)
async function handleStatusCommand(interaction, platform) {
  if (!(platform === "kick" ? KICK_ENABLED : YOUTUBE_ENABLED)) {
    return interaction.reply({
      content: `❌ ${PLATFORM_NAMES[platform]} isn't configured for this bot.`,
      ...ephemeral
    });
  }

  const config = state.guilds[interaction.guildId];
  const streamers = (config ? config.streamers : defaultStreamers()).filter(s => s.platform === platform);

  if (!streamers.length) {
    return interaction.reply({
      content: `No ${PLATFORM_NAMES[platform]} streamers are set up. An admin can add some with \`/streamer add\`.`,
      ...ephemeral
    });
  }

  await interaction.deferReply();

  try {
    const liveEmbeds = [];
    const offline = [];
    const unknown = [];

    if (platform === "kick") {
      const channels = await getKickChannels(streamers.map(s => s.id));
      for (const s of streamers) {
        const ch = channels.get(s.id);
        if (!ch) unknown.push(s);
        else if (ch.stream?.is_live === true) liveEmbeds.push(buildKickAnnouncement(ch).embed);
        else offline.push(s);
      }
    } else {
      const statuses = await getYouTubeStatuses(streamers.map(s => s.id));
      for (const s of streamers) {
        const st = statuses.get(s.id);
        if (!st) unknown.push(s);
        else if (st.live) liveEmbeds.push(buildYouTubeAnnouncement(st.video).embed);
        else offline.push(s);
      }
    }

    const embeds = liveEmbeds.slice(0, 9);

    if (offline.length || unknown.length || !embeds.length) {
      const lines = [
        ...offline.map(s => `⚫ [${s.label}](${streamerLink(s)}) is offline`),
        ...unknown.map(s => `❔ [${s.label}](${streamerLink(s)}) couldn't be checked`)
      ];
      embeds.push(
        new EmbedBuilder()
          .setTitle(`${PLATFORM_NAMES[platform]} status`)
          .setDescription(lines.join("\n") || "Nobody is live right now.")
      );
    }

    await interaction.editReply({ embeds, allowedMentions: noMentions });
  } catch (error) {
    console.error(`[${platform}] Command error:`, error.message);
    await interaction.editReply("❌ Couldn't check right now. Try again in a moment.");
  }
}

async function handleRecheck(interaction) {
  if (Date.now() - lastManualRecheck < MANUAL_RECHECK_COOLDOWN_MS) {
    return interaction.reply({ content: "⏳ A check just ran. Try again in a few seconds.", ...ephemeral });
  }
  lastManualRecheck = Date.now();

  await interaction.deferReply(ephemeral);
  await recheck(true);
  await interaction.editReply("✅ Kick and YouTube status checked.");
}

// ===============================
// INTERACTIONS
// ===============================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (!interaction.inGuild()) {
      return await interaction.reply({
        content: "These commands only work inside a server.",
        ...ephemeral
      });
    }

    const name = interaction.commandName;

    // Public commands
    if (name === "kick" && ENABLE_KICK_COMMAND) return await handleStatusCommand(interaction, "kick");
    if (name === "youtube" && ENABLE_YOUTUBE_COMMAND) return await handleStatusCommand(interaction, "youtube");

    // Defense in depth: Discord already hides these, but verify server-side too
    const needed =
      name === "recheck" ? PermissionsBitField.Flags.Administrator : PermissionsBitField.Flags.ManageGuild;

    if (!interaction.memberPermissions?.has(needed)) {
      return await interaction.reply({ content: "❌ You don't have permission to use this command.", ...ephemeral });
    }

    if (name === "setup") return await handleSetup(interaction);
    if (name === "streamer") return await handleStreamer(interaction);
    if (name === "platform") return await handlePlatform(interaction);
    if (name === "remove") return await handleRemove(interaction);
    if (name === "recheck") return await handleRecheck(interaction);
  } catch (error) {
    console.error("Interaction error:", error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ Something went wrong.");
      } else {
        await interaction.reply({ content: "❌ Something went wrong.", ...ephemeral });
      }
    } catch {}
  }
});

// ===============================
// ERROR HANDLING
// ===============================

process.on("unhandledRejection", error => console.error("Unhandled rejection:", error));
process.on("uncaughtException", error => console.error("Uncaught exception:", error));

// ===============================
// LOGIN
// ===============================

client.login(DISCORD_TOKEN);