const { Client, GatewayIntentBits, Events, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');
require('dotenv').config();

// ---------- Database setup ----------
const db = new Database('levels.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 0,
    lastMessage INTEGER DEFAULT 0
  )
`);

const getUser = db.prepare('SELECT * FROM users WHERE userId = ?');
const insertUser = db.prepare('INSERT INTO users (userId, xp, level, lastMessage) VALUES (?, ?, ?, ?)');
const updateUser = db.prepare('UPDATE users SET xp = ?, level = ?, lastMessage = ? WHERE userId = ?');
const topUsers = db.prepare('SELECT * FROM users ORDER BY xp DESC LIMIT 10');

// ---------- XP / Level math ----------
const COOLDOWN_MS = 60 * 1000; // 60 second cooldown between XP gains
const MIN_XP = 15;
const MAX_XP = 25;

function xpForLevel(level) {
  // XP required to REACH this level (cumulative curve)
  return Math.floor(100 * Math.pow(level, 1.5));
}

function levelFromXp(xp) {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) {
    level++;
  }
  return level;
}

function randomXp() {
  return Math.floor(Math.random() * (MAX_XP - MIN_XP + 1)) + MIN_XP;
}

// ---------- Client setup ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

// ---------- Message XP handling ----------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const userId = message.author.id;
  const now = Date.now();
  let row = getUser.get(userId);

  if (!row) {
    // First time seeing this user — create their row automatically
    insertUser.run(userId, 0, 0, 0);
    row = getUser.get(userId);
  }

  // Cooldown check
  if (now - row.lastMessage < COOLDOWN_MS) return;

  const gained = randomXp();
  const newXp = row.xp + gained;
  const newLevel = levelFromXp(newXp);
  const leveledUp = newLevel > row.level;

  updateUser.run(newXp, newLevel, now, userId);

  if (leveledUp) {
    const embed = new EmbedBuilder()
      .setColor(0xff6b28)
      .setDescription(`🎉 ${message.author} leveled up to **Level ${newLevel}**!`);

    const levelUpChannel = message.guild.channels.cache.get(process.env.LEVEL_UP_CHANNEL_ID);
    if (levelUpChannel) {
      levelUpChannel.send({ embeds: [embed] }).catch(() => {});
    } else {
      console.warn('LEVEL_UP_CHANNEL_ID not found in this server, skipping level-up message.');
    }
  }
});

// ---------- Slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Check your or someone else\'s level and XP')
    .addUserOption((option) =>
      option.setName('user').setDescription('User to check').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top 10 most active members'),
].map((cmd) => cmd.toJSON());

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'rank') {
    const target = interaction.options.getUser('user') || interaction.user;
    const row = getUser.get(target.id);

    if (!row) {
      return interaction.reply({ content: `${target.username} hasn't earned any XP yet.`, ephemeral: true });
    }

    const nextLevelXp = xpForLevel(row.level + 1);
    const currentLevelXp = xpForLevel(row.level);
    const progress = row.xp - currentLevelXp;
    const needed = nextLevelXp - currentLevelXp;

    const embed = new EmbedBuilder()
      .setColor(0xff6b28)
      .setTitle(`${target.username}'s Rank`)
      .addFields(
        { name: 'Level', value: `${row.level}`, inline: true },
        { name: 'Total XP', value: `${row.xp}`, inline: true },
        { name: 'Progress', value: `${progress} / ${needed} XP to next level` }
      )
      .setThumbnail(target.displayAvatarURL());

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'leaderboard') {
    const rows = topUsers.all();

    if (rows.length === 0) {
      return interaction.reply('No one has earned XP yet.');
    }

    const lines = await Promise.all(
      rows.map(async (row, i) => {
        const user = await client.users.fetch(row.userId).catch(() => null);
        const name = user ? user.username : `Unknown (${row.userId})`;
        return `**${i + 1}.** ${name} — Level ${row.level} (${row.xp} XP)`;
      })
    );

    const embed = new EmbedBuilder()
      .setColor(0xff6b28)
      .setTitle('🏆 Leaderboard')
      .setDescription(lines.join('\n'));

    return interaction.reply({ embeds: [embed] });
  }
});

// ---------- Register slash commands ----------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

registerCommands();
client.login(process.env.DISCORD_TOKEN);
