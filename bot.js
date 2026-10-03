// PURNIMA — Kick + YouTube live announcer (Discord)
// Files needed side by side: bot.js, streams.js, package.json
// Render env: DISCORD_TOKEN, KICK_CLIENT_ID, KICK_CLIENT_SECRET, YOUTUBE_API_KEY  (optional: DATA_DIR)

try { require('dotenv').config(); } catch { /* dotenv is optional on Render */ }
const http = require('http');
const { Client, Events, GatewayIntentBits, ActivityType } = require('discord.js');
const streams = require('./streams');

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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands(c) {
  try {
    await c.application.commands.set([]); // clear global copies so commands never show twice
    for (const guild of c.guilds.cache.values()) {
      await guild.commands.set(streams.commands);
      console.log(`✅ Registered ${streams.commands.length} commands in ${guild.name}`);
    }
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
}

client.once(Events.ClientReady, async c => {
  console.log(`✅ PURNIMA logged in as ${c.user.tag} (${c.guilds.cache.size} server(s))`);
  c.user.setPresence({ activities: [{ name: 'live streams | /kickadd', type: ActivityType.Watching }], status: 'online' });
  await registerCommands(c);
  streams.start(c);
});

client.on(Events.InteractionCreate, i => { streams.handle(i).catch(err => console.error('Interaction error:', err)); });
client.on(Events.GuildCreate, g => g.commands.set(streams.commands).catch(console.error));
client.on(Events.GuildDelete, g => streams.forgetGuild(g.id));
client.on('error', err => console.error('Discord client error:', err));

console.log('🚀 Starting PURNIMA…');
client.login(TOKEN).catch(err => { console.error('❌ Discord login failed:', err.message); process.exit(1); });