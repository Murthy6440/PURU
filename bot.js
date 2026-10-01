require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  Events
} = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===============================
// ENVIRONMENT VARIABLES
// ===============================

const {
  DISCORD_TOKEN,
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  YOUTUBE_API_KEY,
  ANNOUNCEMENT_CHANNEL_ID,
  KICK_USERNAME,
  YOUTUBE_CHANNEL_ID
} = process.env;

for (const key of ["DISCORD_TOKEN", "ANNOUNCEMENT_CHANNEL_ID"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const KICK_ENABLED = Boolean(KICK_USERNAME && KICK_CLIENT_ID && KICK_CLIENT_SECRET);
const YOUTUBE_ENABLED = Boolean(
  YOUTUBE_API_KEY && YOUTUBE_CHANNEL_ID && /^UC/.test(YOUTUBE_CHANNEL_ID)
);

if (!KICK_ENABLED) console.warn("[Kick] Disabled (missing KICK_USERNAME / KICK_CLIENT_ID / KICK_CLIENT_SECRET)");
if (!YOUTUBE_ENABLED) console.warn("[YouTube] Disabled (need YOUTUBE_API_KEY and a channel ID starting with UC)");

const CHECK_INTERVAL = 30 * 1000;
const FETCH_TIMEOUT = 10 * 1000;

// A stream counts as the "same" broadcast until it has been offline this long.
// Stops re-announcements from API blips or a quick stream restart.
const OFFLINE_RESET_MS = 10 * 60 * 1000;

// The role is pinged at most once per this window, even if you go live on
// Kick and YouTube at different times (the 2nd announcement is sent without a ping).
const PING_COOLDOWN_MS = 15 * 60 * 1000;

const COMMAND_ENABLEMENTS = {
  recheck: process.env.ENABLE_RECHECK !== "false"
};

function normalizeMentionRoleId(value) {
  if (!value) return null;
  const id = String(value).trim().replace(/^<@&?|>|@/g, "").trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

const ANNOUNCEMENT_ROLE_ID = normalizeMentionRoleId(process.env.ANNOUNCEMENT_ROLE_ID);

// ===============================
// SINGLE-INSTANCE LOCK
// (two copies of the bot running = every announcement posted twice)
// ===============================

const LOCK_FILE = path.join(__dirname, "bot.lock");

function acquireLock() {
  try {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // throws if the process doesn't exist
        console.error(
          `Another instance is already running (pid ${oldPid}). Stop it first, or delete bot.lock if it is stale.`
        );
        process.exit(1);
      } catch (e) {
        if (e.code === "EPERM") {
          console.error(`Another instance appears to be running (pid ${oldPid}).`);
          process.exit(1);
        }
        /* ESRCH: stale lock, continue */
      }
    }
  } catch {
    /* no lock file */
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
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
// STATE (persisted so restarts don't re-announce)
// ===============================

const STATE_FILE = path.join(__dirname, "state.json");

const state = {
  kick: { announced: false, lastLive: 0 },
  youtube: { announced: false, lastLive: 0 },
  lastPingAt: 0
};

try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  Object.assign(state.kick, saved.kick);
  Object.assign(state.youtube, saved.youtube);
  state.lastPingAt = saved.lastPingAt || 0;

  // migrate state.json written by the previous version
  if (saved.kickAnnounced && !saved.kick) Object.assign(state.kick, { announced: true, lastLive: Date.now() });
  if (saved.youtubeAnnounced && !saved.youtube) Object.assign(state.youtube, { announced: true, lastLive: Date.now() });
} catch {
  /* first run */
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save state:", e.message);
  }
}

let kickToken = null;
let kickTokenExpiresAt = 0;

// ===============================
// HELPERS
// ===============================

async function fetchTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
}

async function getAnnouncementChannel() {
  const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
  if (!channel || !channel.isTextBased() || typeof channel.send !== "function") {
    throw new Error("Invalid announcement channel");
  }
  return channel;
}

// Extra safety net: if the bot already posted this link recently (e.g. from a
// second instance on another machine), don't post it again.
async function alreadyPosted(channel, urls) {
  try {
    const messages = await channel.messages.fetch({ limit: 15 });
    const cutoff = Date.now() - OFFLINE_RESET_MS;
    return messages.some(
      m =>
        m.author.id === client.user.id &&
        m.createdTimestamp > cutoff &&
        m.embeds.some(e => e.url && urls.includes(e.url))
    );
  } catch {
    return false; // missing Read Message History permission etc.
  }
}

function trackLive(platformState, live) {
  const now = Date.now();
  if (live) {
    platformState.lastLive = now;
  } else if (platformState.announced && now - platformState.lastLive > OFFLINE_RESET_MS) {
    platformState.announced = false;
  }
}

// ===============================
// KICK
// ===============================

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

async function getKickStatus() {
  const token = await getKickToken();

  const response = await fetchTimeout(
    `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(KICK_USERNAME)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );

  if (response.status === 401) {
    kickToken = null;
    throw new Error("Kick API error: 401 (token reset)");
  }
  if (!response.ok) throw new Error(`Kick API error: ${response.status}`);

  const data = await response.json();
  const channel = data.data?.[0];
  if (!channel) throw new Error(`Channel not found: ${KICK_USERNAME}`);

  const live = channel.stream?.is_live === true;
  console.log(`[Kick] ${KICK_USERNAME}: ${live ? "LIVE" : "OFFLINE"}`);
  return { live, channel };
}

function buildKickAnnouncement(channel) {
  const stream = channel.stream || {};
  const name = channel.slug || KICK_USERNAME;
  const title = channel.stream_title || `${name} is Live!`;
  const category = channel.category?.name || "Live Stream";
  const viewers = stream.viewer_count ?? 0;
  const thumbnail = stream.thumbnail || channel.banner_picture || null;
  const url = `https://kick.com/${KICK_USERNAME}`;

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

  return { platform: "kick", title, url, embed };
}

// ===============================
// YOUTUBE
// (uploads playlist + videos.list = ~2 quota units/check; search.list would
// cost 100 units and exhaust the daily quota in under an hour)
// ===============================

async function getYouTubeStatus() {
  const key = encodeURIComponent(YOUTUBE_API_KEY);
  const uploadsPlaylist = "UU" + YOUTUBE_CHANNEL_ID.slice(2);

  const plRes = await fetchTimeout(
    "https://www.googleapis.com/youtube/v3/playlistItems" +
      `?part=contentDetails&maxResults=10&playlistId=${encodeURIComponent(uploadsPlaylist)}&key=${key}`
  );
  if (!plRes.ok) throw new Error(`YouTube playlist API error: ${plRes.status}`);

  const pl = await plRes.json();
  const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);

  let liveVideo = null;
  if (ids.length) {
    const vRes = await fetchTimeout(
      "https://www.googleapis.com/youtube/v3/videos" +
        `?part=snippet&id=${ids.join(",")}&key=${key}`
    );
    if (!vRes.ok) throw new Error(`YouTube videos API error: ${vRes.status}`);
    const v = await vRes.json();
    liveVideo = (v.items || []).find(i => i.snippet?.liveBroadcastContent === "live") || null;
  }

  console.log(`[YouTube] ${liveVideo ? "LIVE: " + liveVideo.id : "OFFLINE"}`);
  return { live: Boolean(liveVideo), video: liveVideo };
}

function buildYouTubeAnnouncement(video) {
  const snippet = video.snippet;
  const title = snippet.title || "YouTube Live Stream";
  const url = `https://www.youtube.com/watch?v=${video.id}`;
  const thumbnail =
    snippet.thumbnails?.maxres?.url ||
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${snippet.channelTitle} is LIVE on YouTube` })
    .setTitle(title.slice(0, 256))
    .setURL(url)
    .setDescription(
      `🔴 **${snippet.channelTitle} is now live!**\n\n` +
        `📺 **Watch the stream on YouTube**`
    )
    .setTimestamp()
    .setFooter({ text: "YouTube Live Notification" });

  if (thumbnail) embed.setImage(thumbnail);

  return { platform: "youtube", title, url, embed };
}

// ===============================
// ANNOUNCE (one message, one ping, even if both platforms go live together)
// ===============================

async function announce(pending) {
  const channel = await getAnnouncementChannel();

  if (await alreadyPosted(channel, pending.map(p => p.url))) {
    console.log("Already announced recently in channel, skipping");
    return;
  }

  const now = Date.now();
  const shouldPing = ANNOUNCEMENT_ROLE_ID && now - state.lastPingAt > PING_COOLDOWN_MS;
  const mention = shouldPing ? `<@&${ANNOUNCEMENT_ROLE_ID}> ` : "";

  await channel.send({
    content: `${mention}${pending[0].title}`.slice(0, 2000),
    embeds: pending.map(p => p.embed),
    allowedMentions: { roles: shouldPing ? [ANNOUNCEMENT_ROLE_ID] : [] }
  });

  if (shouldPing) state.lastPingAt = now;
  console.log(`Announcement sent: ${pending.map(p => p.platform).join(" + ")}`);
}

// ===============================
// RECHECK (with overlap guard)
// ===============================

let checking = false;

async function recheck() {
  if (checking) {
    console.log("Previous check still running, skipping");
    return;
  }
  checking = true;

  try {
    console.log("Checking Kick + YouTube...");

    const [kickRes, ytRes] = await Promise.allSettled([
      KICK_ENABLED ? getKickStatus() : Promise.resolve(null),
      YOUTUBE_ENABLED ? getYouTubeStatus() : Promise.resolve(null)
    ]);

    const pending = [];

    // On an API error we leave that platform's state untouched
    if (kickRes.status === "rejected") {
      console.error("[Kick] Error:", kickRes.reason?.message);
    } else if (kickRes.value) {
      const { live, channel } = kickRes.value;
      trackLive(state.kick, live);
      if (live && !state.kick.announced) pending.push(buildKickAnnouncement(channel));
    }

    if (ytRes.status === "rejected") {
      console.error("[YouTube] Error:", ytRes.reason?.message);
    } else if (ytRes.value) {
      const { live, video } = ytRes.value;
      trackLive(state.youtube, live);
      if (live && !state.youtube.announced) pending.push(buildYouTubeAnnouncement(video));
    }

    saveState();

    if (!pending.length) return;

    try {
      await announce(pending);
    } catch (error) {
      console.error("Announcement failed (will retry next check):", error.message);
      return;
    }

    // Mark as announced only after the send succeeded
    for (const p of pending) state[p.platform].announced = true;
    saveState();
  } finally {
    checking = false;
  }
}

// ===============================
// SLASH COMMANDS
// ===============================

const commands = [
  COMMAND_ENABLEMENTS.recheck
    ? new SlashCommandBuilder()
        .setName("recheck")
        .setDescription("Immediately check Kick and YouTube live status")
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    : null
]
  .filter(Boolean)
  .map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  if (client.guilds.cache.size === 0) {
    console.error("No Discord server found. Make sure the bot is invited to a server.");
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
        body: commands
      });
      console.log(`Slash commands registered in ${guild.name} (${guild.id})`);
    } catch (error) {
      console.error(`Failed to register slash commands in ${guild.name}:`, error);
    }
  }
}

// ===============================
// READY
// ===============================

let started = false;

client.once(Events.ClientReady, async () => {
  if (started) return;
  started = true;

  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();
  await recheck();

  setInterval(recheck, CHECK_INTERVAL);

  console.log("Kick + YouTube checker started");
  console.log("Checking every 30 seconds");
});

// ===============================
// INTERACTIONS
// ===============================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "recheck") return;

  try {
    if (!COMMAND_ENABLEMENTS.recheck) {
      return await interaction.reply({
        content: "❌ This command is disabled.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      return await interaction.reply({
        content: "❌ Administrator permission required.",
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await recheck();
    await interaction.editReply("✅ Kick and YouTube status checked.");
  } catch (error) {
    console.error("Interaction error:", error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ Something went wrong.");
      } else {
        await interaction.reply({ content: "❌ Something went wrong.", flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* interaction expired */
    }
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