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

// Fail fast on missing required config
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
const OFFLINE_STRIKES_REQUIRED = 2; // avoids re-announcing after a one-off API blip
const FETCH_TIMEOUT = 10 * 1000;

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
// STATE (persisted so restarts don't re-announce)
// ===============================

const STATE_FILE = path.join(__dirname, "state.json");

let state = { kickAnnounced: null, youtubeAnnounced: null };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
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
let kickOfflineStrikes = 0;
let youtubeOfflineStrikes = 0;

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

async function sendAnnouncement(title, embed) {
  const channel = await getAnnouncementChannel();
  const mention = ANNOUNCEMENT_ROLE_ID ? `<@&${ANNOUNCEMENT_ROLE_ID}> ` : "";

  await channel.send({
    content: `${mention}${title}`,
    embeds: [embed],
    allowedMentions: { roles: ANNOUNCEMENT_ROLE_ID ? [ANNOUNCEMENT_ROLE_ID] : [] }
  });
}

// ===============================
// KICK
// ===============================

async function getKickToken() {
  if (kickToken && Date.now() < kickTokenExpiresAt) return kickToken;

  // Kick expects client credentials in the form body (not Basic auth)
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

async function checkKick() {
  if (!KICK_ENABLED) return;

  try {
    const token = await getKickToken();

    const response = await fetchTimeout(
      `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(KICK_USERNAME)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );

    if (response.status === 401) {
      kickToken = null; // force a fresh token next time
      throw new Error("Kick API error: 401 (token reset)");
    }
    if (!response.ok) throw new Error(`Kick API error: ${response.status}`);

    const data = await response.json();
    const channel = data.data?.[0];

    if (!channel) {
      console.log(`[Kick] Channel not found: ${KICK_USERNAME}`);
      return;
    }

    const isLive = channel.stream?.is_live === true;
    console.log(`[Kick] ${KICK_USERNAME}: ${isLive ? "LIVE" : "OFFLINE"}`);

    if (!isLive) {
      if (++kickOfflineStrikes >= OFFLINE_STRIKES_REQUIRED && state.kickAnnounced) {
        state.kickAnnounced = null;
        saveState();
      }
      return;
    }

    kickOfflineStrikes = 0;

    // start_time is stable for the whole broadcast and changes on the next one
    const sessionId = channel.stream.start_time || `${KICK_USERNAME}-live`;
    const key = `${KICK_USERNAME}:${sessionId}`;

    if (state.kickAnnounced === key) return;

    await announceKick(channel);

    // Only mark as announced after a successful send, so failures are retried
    state.kickAnnounced = key;
    saveState();
  } catch (error) {
    console.error("[Kick] Error:", error.message);
  }
}

async function announceKick(channel) {
  const stream = channel.stream || {};
  const name = channel.slug || KICK_USERNAME;
  const title = channel.stream_title || `${name} is Live!`;
  const category = channel.category?.name || "Live Stream";
  const viewers = stream.viewer_count ?? 0;
  const thumbnail = stream.thumbnail || channel.banner_picture || null;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${name} is LIVE on Kick` })
    .setTitle(title.slice(0, 256))
    .setURL(`https://kick.com/${KICK_USERNAME}`)
    .setDescription(
      `🔴 **${name} is now live!**\n\n` +
        `🎮 **Category:** ${category}\n` +
        `👥 **Viewers:** ${viewers}`
    )
    .setTimestamp()
    .setFooter({ text: "Kick Live Notification" });

  if (thumbnail) embed.setImage(thumbnail);

  await sendAnnouncement(title, embed);
  console.log("[Kick] Announcement sent");
}

// ===============================
// YOUTUBE
// ===============================
// search.list costs 100 quota units per call (daily quota is 10,000), so polling it
// every 30s burns the quota in under an hour. Instead we use the uploads playlist
// (1 unit) + videos.list (1 unit) = 2 units per check.

async function findYouTubeLiveVideo() {
  const key = encodeURIComponent(YOUTUBE_API_KEY);
  const uploadsPlaylist = "UU" + YOUTUBE_CHANNEL_ID.slice(2);

  const plRes = await fetchTimeout(
    "https://www.googleapis.com/youtube/v3/playlistItems" +
      `?part=contentDetails&maxResults=10&playlistId=${encodeURIComponent(uploadsPlaylist)}&key=${key}`
  );
  if (!plRes.ok) throw new Error(`YouTube playlist API error: ${plRes.status}`);

  const pl = await plRes.json();
  const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return null;

  const vRes = await fetchTimeout(
    "https://www.googleapis.com/youtube/v3/videos" +
      `?part=snippet,liveStreamingDetails&id=${ids.join(",")}&key=${key}`
  );
  if (!vRes.ok) throw new Error(`YouTube videos API error: ${vRes.status}`);

  const v = await vRes.json();
  return (v.items || []).find(item => item.snippet?.liveBroadcastContent === "live") || null;
}

async function checkYouTube() {
  if (!YOUTUBE_ENABLED) return;

  try {
    const liveVideo = await findYouTubeLiveVideo();

    if (!liveVideo) {
      console.log("[YouTube] OFFLINE");
      if (++youtubeOfflineStrikes >= OFFLINE_STRIKES_REQUIRED && state.youtubeAnnounced) {
        state.youtubeAnnounced = null;
        saveState();
      }
      return;
    }

    youtubeOfflineStrikes = 0;

    const key = `${YOUTUBE_CHANNEL_ID}:${liveVideo.id}`;
    console.log(`[YouTube] LIVE: ${liveVideo.id}`);

    if (state.youtubeAnnounced === key) return;

    await announceYouTube(liveVideo);

    state.youtubeAnnounced = key;
    saveState();
  } catch (error) {
    console.error("[YouTube] Error:", error.message);
  }
}

async function announceYouTube(video) {
  const snippet = video.snippet;
  const title = snippet.title || "YouTube Live Stream";
  const thumbnail =
    snippet.thumbnails?.maxres?.url ||
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${snippet.channelTitle} is LIVE on YouTube` })
    .setTitle(title.slice(0, 256))
    .setURL(`https://www.youtube.com/watch?v=${video.id}`)
    .setDescription(
      `🔴 **${snippet.channelTitle} is now live!**\n\n` +
        `📺 **Watch the stream on YouTube**`
    )
    .setTimestamp()
    .setFooter({ text: "YouTube Live Notification" });

  if (thumbnail) embed.setImage(thumbnail);

  await sendAnnouncement(title, embed);
  console.log("[YouTube] Announcement sent");
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
    await Promise.allSettled([checkKick(), checkYouTube()]);
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

client.once(Events.ClientReady, async () => {
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