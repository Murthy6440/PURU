require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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

const CHECK_INTERVAL = 30 * 1000;

const COMMAND_ENABLEMENTS = {
  recheck: process.env.ENABLE_RECHECK !== "false",
  kick: process.env.ENABLE_KICK_COMMAND !== "false",
  youtube: process.env.ENABLE_YOUTUBE_COMMAND !== "false"
};

function normalizeMentionRoleId(value) {
  if (!value) return null;
  const cleaned = String(value).trim();
  const id = cleaned.replace(/^<@&?|>|@/g, "").trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

const ANNOUNCEMENT_ROLE_ID = normalizeMentionRoleId(process.env.ANNOUNCEMENT_ROLE_ID);

// ===============================
// STATE
// ===============================

let kickToken = null;
let kickTokenExpiresAt = 0;

let kickLive = false;
let lastKickSessionId = null;
let lastKickAnnouncementKey = null;

let youtubeLive = false;
let lastYoutubeVideoId = null;
let lastYoutubeAnnouncementKey = null;

// ===============================
// DISCORD CHANNEL
// ===============================

async function getAnnouncementChannel() {
  const channel = await client.channels.fetch(
    ANNOUNCEMENT_CHANNEL_ID
  );

  if (!channel || !channel.isTextBased()) {
    throw new Error("Invalid announcement channel");
  }

  return channel;
}

// ===============================
// KICK TOKEN
// ===============================

async function getKickToken() {
  if (
    kickToken &&
    Date.now() < kickTokenExpiresAt
  ) {
    return kickToken;
  }

  const credentials = Buffer.from(
    `${KICK_CLIENT_ID}:${KICK_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    "https://id.kick.com/oauth/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials"
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Kick token error: ${response.status}`
    );
  }

  const data = await response.json();

  kickToken = data.access_token;

  kickTokenExpiresAt =
    Date.now() +
    ((data.expires_in || 3600) - 60) * 1000;

  return kickToken;
}

// ===============================
// KICK CHECK
// ===============================

async function checkKick() {
  try {
    if (!KICK_USERNAME) {
      console.log("[Kick] Username not configured");
      return;
    }

    const token = await getKickToken();

    const response = await fetch(
      `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(
        KICK_USERNAME
      )}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `Kick API error: ${response.status}`
      );
    }

    const data = await response.json();
    const channel = data.data?.[0];

    if (!channel) {
      console.log(
        `[Kick] Channel not found: ${KICK_USERNAME}`
      );
      return;
    }

    const stream = channel.stream;

    const isLive =
      stream?.is_live === true;

    console.log(
      `[Kick] ${KICK_USERNAME}: ${
        isLive ? "LIVE" : "OFFLINE"
      }`
    );

    if (!isLive) {
      kickLive = false;
      lastKickSessionId = null;
      lastKickAnnouncementKey = null;
      return;
    }

    const sessionId =
      stream?.stream_id ||
      stream?.id ||
      stream?.session_id ||
      `${KICK_USERNAME}-live`;

    const announcementKey = `${KICK_USERNAME}:${sessionId}`;

    if (
      kickLive &&
      lastKickSessionId === sessionId &&
      lastKickAnnouncementKey === announcementKey
    ) {
      return;
    }

    kickLive = true;
    lastKickSessionId = sessionId;
    lastKickAnnouncementKey = announcementKey;

    await announceKick(channel);

  } catch (error) {
    console.error(
      "[Kick] Error:",
      error.message
    );
  }
}

// ===============================
// KICK ANNOUNCEMENT
// ===============================

async function announceKick(channel) {
  const discordChannel =
    await getAnnouncementChannel();

  const stream = channel.stream || {};

  const title =
    stream.title ||
    `${channel.name || KICK_USERNAME} is Live!`;

  const category =
    stream.category?.name ||
    "Live Stream";

  const viewers =
    stream.viewer_count ??
    stream.viewers ??
    0;

  const thumbnail =
    stream.thumbnail ||
    channel.banner_picture ||
    null;

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${channel.name || KICK_USERNAME} is LIVE on Kick`
    })
    .setTitle(title)
    .setURL(
      `https://kick.com/${KICK_USERNAME}`
    )
    .setDescription(
      `🔴 **${channel.name || KICK_USERNAME} is now live!**\n\n` +
      `🎮 **Category:** ${category}\n` +
      `👥 **Viewers:** ${viewers}`
    )
    .setTimestamp()
    .setFooter({
      text: "Kick Live Notification"
    });

  if (thumbnail) {
    embed.setImage(thumbnail);
  }

  const mention = ANNOUNCEMENT_ROLE_ID
    ? `<@&${ANNOUNCEMENT_ROLE_ID}>`
    : "";

  await discordChannel.send({
    content: `${mention}${mention ? " " : ""}${title}`,
    embeds: [embed],
    allowedMentions: {
      roles: ANNOUNCEMENT_ROLE_ID
        ? [ANNOUNCEMENT_ROLE_ID]
        : []
    }
  });

  console.log(
    "[Kick] Announcement sent"
  );
}

// ===============================
// YOUTUBE CHECK
// ===============================

async function checkYouTube() {
  try {
    if (!YOUTUBE_CHANNEL_ID) {
      console.log(
        "[YouTube] Channel ID not configured"
      );
      return;
    }

    const url =
      "https://www.googleapis.com/youtube/v3/search" +
      `?part=snippet&channelId=${encodeURIComponent(
        YOUTUBE_CHANNEL_ID
      )}` +
      "&eventType=live" +
      "&type=video" +
      "&maxResults=1" +
      `&key=${encodeURIComponent(
        YOUTUBE_API_KEY
      )}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `YouTube API error: ${response.status}`
      );
    }

    const data = await response.json();

    const liveVideo =
      data.items?.[0];

    if (!liveVideo) {
      console.log(
        "[YouTube] OFFLINE"
      );

      youtubeLive = false;
      lastYoutubeVideoId = null;
      lastYoutubeAnnouncementKey = null;

      return;
    }

    const videoId =
      liveVideo.id?.videoId;

    if (!videoId) {
      return;
    }

    const announcementKey = `${YOUTUBE_CHANNEL_ID}:${videoId}`;

    console.log(
      `[YouTube] LIVE: ${videoId}`
    );

    if (
      youtubeLive &&
      lastYoutubeVideoId === videoId &&
      lastYoutubeAnnouncementKey === announcementKey
    ) {
      return;
    }

    youtubeLive = true;
    lastYoutubeVideoId = videoId;
    lastYoutubeAnnouncementKey = announcementKey;

    await announceYouTube(
      liveVideo
    );

  } catch (error) {
    console.error(
      "[YouTube] Error:",
      error.message
    );
  }
}

// ===============================
// YOUTUBE ANNOUNCEMENT
// ===============================

async function announceYouTube(video) {
  const discordChannel =
    await getAnnouncementChannel();

  const snippet =
    video.snippet;

  const videoId =
    video.id.videoId;

  const title =
    snippet.title ||
    "YouTube Live Stream";

  const thumbnail =
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${snippet.channelTitle} is LIVE on YouTube`
    })
    .setTitle(title)
    .setURL(
      `https://www.youtube.com/watch?v=${videoId}`
    )
    .setDescription(
      `🔴 **${snippet.channelTitle} is now live!**\n\n` +
      `📺 **Watch the stream on YouTube**`
    )
    .setTimestamp()
    .setFooter({
      text: "YouTube Live Notification"
    });

  if (thumbnail) {
    embed.setImage(thumbnail);
  }

  const mention = ANNOUNCEMENT_ROLE_ID
    ? `<@&${ANNOUNCEMENT_ROLE_ID}>`
    : "";

  await discordChannel.send({
    content: `${mention}${mention ? " " : ""}${title}`,
    embeds: [embed],
    allowedMentions: {
      roles: ANNOUNCEMENT_ROLE_ID
        ? [ANNOUNCEMENT_ROLE_ID]
        : []
    }
  });

  console.log(
    "[YouTube] Announcement sent"
  );
}

// ===============================
// RECHECK
// ===============================

async function recheck() {
  console.log(
    "Checking Kick + YouTube..."
  );

  await Promise.allSettled([
    checkKick(),
    checkYouTube()
  ]);
}

// ===============================
// SLASH COMMAND
// ===============================

const commands = [
  COMMAND_ENABLEMENTS.recheck ? new SlashCommandBuilder()
    .setName("recheck")
    .setDescription(
      "Immediately check Kick and YouTube live status"
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.Administrator.toString()
    ) : null,
].filter(Boolean).map(command =>
  command.toJSON()
);

// ===============================
// REGISTER COMMAND
// ===============================

async function registerCommands() {
  const rest = new REST({
    version: "10"
  }).setToken(DISCORD_TOKEN);

  const guild = client.guilds.cache.first();

  if (!guild) {
    console.error(
      "No Discord server found. Make sure the bot is invited to a server."
    );
    return;
  }

  try {
    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        guild.id
      ),
      {
        body: commands
      }
    );

    console.log(
      `Slash commands registered in ${guild.name} (${guild.id})`
    );
  } catch (error) {
    console.error(
      "Failed to register slash commands:",
      error
    );
  }
}

// ===============================
// READY
// ===============================

client.once(
  "ready",
  async () => {
    console.log(
      `Logged in as ${client.user.tag}`
    );

    await registerCommands();

    await recheck();

    setInterval(
      recheck,
      CHECK_INTERVAL
    );

    console.log(
      "Kick + YouTube checker started"
    );

    console.log(
      "Checking every 30 seconds"
    );
  }
);

// ===============================
// INTERACTION
// ===============================

client.on(
  "interactionCreate",
  async interaction => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    if (
      interaction.commandName !==
      "recheck"
    ) {
      return;
    }

    if (!COMMAND_ENABLEMENTS.recheck) {
      return interaction.reply({
        content: "❌ This command is disabled.",
        ephemeral: true
      });
    }

    if (
      !interaction.memberPermissions?.has(
        PermissionsBitField.Flags.Administrator
      )
    ) {
      return interaction.reply({
        content:
          "❌ Administrator permission required.",
        ephemeral: true
      });
    }

    await interaction.deferReply({
      ephemeral: true
    });

    await recheck();

    await interaction.editReply(
      "✅ Kick and YouTube status checked."
    );
  }
);

// ===============================
// ERROR HANDLING
// ===============================

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

// ===============================
// LOGIN
// ===============================

client.login(
  DISCORD_TOKEN
);