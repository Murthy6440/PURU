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
// Optional:  KICK_USERNAME, KICK_CLIENT_ID, KICK_CLIENT_SECRET
//            YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID (starts with UC)
//            DATA_DIR  (folder for state.json; point at a persistent disk on Render, e.g. /data)
//            ANNOUNCEMENT_CHANNEL_ID / ANNOUNCEMENT_ROLE_ID  (optional: auto-configures that one server)
// Each server picks its own channel + role with /setup.

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

const KICK_ENABLED = Boolean(KICK_USERNAME && KICK_CLIENT_ID && KICK_CLIENT_SECRET);
const YOUTUBE_ENABLED = Boolean(
  YOUTUBE_API_KEY && YOUTUBE_CHANNEL_ID && /^UC/.test(YOUTUBE_CHANNEL_ID)
);

if (!KICK_ENABLED) console.warn("[Kick] Disabled (missing KICK_USERNAME / KICK_CLIENT_ID / KICK_CLIENT_SECRET)");
if (!YOUTUBE_ENABLED) console.warn("[YouTube] Disabled (need YOUTUBE_API_KEY and a channel ID starting with UC)");

const CHECK_INTERVAL = 30 * 1000;
const FETCH_TIMEOUT = 10 * 1000;
const OFFLINE_RESET_MS = 10 * 60 * 1000; // offline this long = next live is a new broadcast
const PING_COOLDOWN_MS = 15 * 60 * 1000; // max one role ping per server per window
const MANUAL_RECHECK_COOLDOWN_MS = 10 * 1000;

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
// state.guilds[guildId] = { channelId, roleId, kickAnnounced, youtubeAnnounced, lastPingAt }

const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {}
const STATE_FILE = path.join(DATA_DIR, "state.json");

const state = {
  kick: { lastLive: 0 },
  youtube: { lastLive: 0 },
  guilds: {}
};

try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  Object.assign(state.kick, saved.kick);
  Object.assign(state.youtube, saved.youtube);
  Object.assign(state.guilds, saved.guilds);
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

function newGuildConfig(channelId, roleId) {
  return {
    channelId,
    roleId: roleId || null,
    kickAnnounced: false,
    youtubeAnnounced: false,
    lastPingAt: 0
  };
}

let kickToken = null;
let kickTokenExpiresAt = 0;

// ===============================
// HELPERS
// ===============================

async function fetchTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
}

// Safety net against duplicates (e.g. a second instance, or lost state)
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
    return false;
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
// YOUTUBE (uploads playlist + videos.list ≈ 2 quota units per check)
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
      "https://www.googleapis.com/youtube/v3/videos" + `?part=snippet&id=${ids.join(",")}&key=${key}`
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
    .setDescription(`🔴 **${snippet.channelTitle} is now live!**\n\n📺 **Watch the stream on YouTube**`)
    .setTimestamp()
    .setFooter({ text: "YouTube Live Notification" });

  if (thumbnail) embed.setImage(thumbnail);

  return { platform: "youtube", title, url, embed };
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

  const markDone = () => {
    for (const p of pending) config[`${p.platform}Announced`] = true;
  };

  if (await alreadyPosted(channel, pending.map(p => p.url))) {
    console.log(`[${guildId}] Already announced recently, skipping`);
    markDone();
    return;
  }

  const now = Date.now();
  const shouldPing = config.roleId && now - config.lastPingAt > PING_COOLDOWN_MS;
  const mention = shouldPing ? `<@&${config.roleId}> ` : "";

  await channel.send({
    content: `${mention}${pending[0].title}`.slice(0, 2000),
    embeds: pending.map(p => p.embed),
    allowedMentions: { roles: shouldPing ? [config.roleId] : [] }
  });

  if (shouldPing) config.lastPingAt = now;
  markDone();
  console.log(`[${guildId}] Announcement sent: ${pending.map(p => p.platform).join(" + ")}`);
}

// ===============================
// RECHECK
// ===============================

let checking = false;
let lastManualRecheck = 0;

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

    const now = Date.now();
    const live = {}; // platform -> announcement payload, for platforms currently live

    function handle(platform, result, build) {
      if (result.status === "rejected") {
        console.error(`[${platform}] Error:`, result.reason?.message);
        return; // unknown status: leave state untouched
      }
      if (!result.value) return; // platform disabled

      if (result.value.live) {
        state[platform].lastLive = now;
        live[platform] = build(result.value);
      } else if (now - state[platform].lastLive > OFFLINE_RESET_MS) {
        // offline long enough: next stream gets announced again in every server
        for (const g of Object.values(state.guilds)) g[`${platform}Announced`] = false;
      }
    }

    handle("kick", kickRes, v => buildKickAnnouncement(v.channel));
    handle("youtube", ytRes, v => buildYouTubeAnnouncement(v.video));

    for (const [guildId, config] of Object.entries(state.guilds)) {
      const pending = Object.keys(live)
        .filter(platform => !config[`${platform}Announced`])
        .map(platform => live[platform]);

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
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Stop live announcements in this server")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("recheck")
    .setDescription("Immediately check Kick and YouTube live status")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  try {
    // Global commands: every server (including new ones) gets them automatically
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Global slash commands registered");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  // Clear leftover per-server commands from older versions (avoids duplicate /recheck)
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: [] });
    } catch {}
  }
}

// ===============================
// READY
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

  console.log("Kick + YouTube checker started (every 30 seconds)");
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
// INTERACTIONS
// ===============================

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
      flags: MessageFlags.Ephemeral
    });
  }

  const existing = state.guilds[interaction.guildId];
  state.guilds[interaction.guildId] = {
    ...newGuildConfig(channel.id, role?.id),
    // keep dedupe flags if only the channel/role changed mid-stream
    kickAnnounced: existing?.kickAnnounced || false,
    youtubeAnnounced: existing?.youtubeAnnounced || false,
    lastPingAt: existing?.lastPingAt || 0
  };
  saveState();

  let note = "";
  if (role && !role.mentionable && !me.permissions.has(PermissionsBitField.Flags.MentionEveryone)) {
    note =
      "\n⚠️ That role isn't mentionable and I lack the **Mention Everyone** permission, so the ping won't work. Make the role mentionable or grant me that permission.";
  }

  await interaction.reply({
    content:
      `✅ Live announcements will be posted in ${channel}` +
      (role ? ` and ping ${role}.` : " with no role ping.") +
      note,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}

async function handleRemove(interaction) {
  if (!state.guilds[interaction.guildId]) {
    return interaction.reply({
      content: "This server isn't set up yet. Use /setup first.",
      flags: MessageFlags.Ephemeral
    });
  }
  delete state.guilds[interaction.guildId];
  saveState();
  await interaction.reply({
    content: "✅ Live announcements disabled for this server.",
    flags: MessageFlags.Ephemeral
  });
}

async function handleRecheck(interaction) {
  if (Date.now() - lastManualRecheck < MANUAL_RECHECK_COOLDOWN_MS) {
    return interaction.reply({
      content: "⏳ A check just ran. Try again in a few seconds.",
      flags: MessageFlags.Ephemeral
    });
  }
  lastManualRecheck = Date.now();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await recheck();
  await interaction.editReply("✅ Kick and YouTube status checked.");
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (!interaction.inGuild()) {
      return await interaction.reply({
        content: "These commands only work inside a server.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Defense in depth: Discord already hides these, but verify server-side too
    const needed =
      interaction.commandName === "recheck"
        ? PermissionsBitField.Flags.Administrator
        : PermissionsBitField.Flags.ManageGuild;

    if (!interaction.memberPermissions?.has(needed)) {
      return await interaction.reply({
        content: "❌ You don't have permission to use this command.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "setup") return await handleSetup(interaction);
    if (interaction.commandName === "remove") return await handleRemove(interaction);
    if (interaction.commandName === "recheck") return await handleRecheck(interaction);
  } catch (error) {
    console.error("Interaction error:", error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ Something went wrong.");
      } else {
        await interaction.reply({ content: "❌ Something went wrong.", flags: MessageFlags.Ephemeral });
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