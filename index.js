import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'invites.json');
const PREFIX = '-inv';
const RESET_PREFIX = '-resetinv';
const fakeAccountAgeDays = Number(process.env.FAKE_ACCOUNT_AGE_DAYS ?? 7);
const fakeAccountAgeMs = fakeAccountAgeDays * 24 * 60 * 60 * 1000;
const inviteResetterIds = new Set(
  (process.env.INVITE_RESETTER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

if (!process.env.DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN is missing. Copy .env.example to .env and add your token.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// guildId -> Map(inviteCode, numberOfUses)
const inviteCache = new Map();
let database = { guilds: {} };
let saveChain = Promise.resolve();

async function loadDatabase() {
  try {
    database = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

function saveDatabase() {
  // Serialize writes so a quick leave/rejoin cannot overwrite newer data.
  saveChain = saveChain.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(database, null, 2), 'utf8');
  });
  return saveChain;
}

function getGuildData(guildId) {
  database.guilds[guildId] ??= { members: {}, resets: {} };
  database.guilds[guildId].members ??= {};
  database.guilds[guildId].resets ??= {};
  return database.guilds[guildId];
}

function snapshotInvites(guild, invites) {
  inviteCache.set(guild.id, new Map(invites.map((invite) => [invite.code, invite.uses ?? 0])));
}

async function refreshInviteSnapshot(guild) {
  try {
    const invites = await guild.invites.fetch();
    snapshotInvites(guild, invites);
    return invites;
  } catch (error) {
    console.error(`Could not fetch invites for ${guild.name} (${guild.id}):`, error.message);
    return null;
  }
}

async function findUsedInvite(guild) {
  const oldUses = inviteCache.get(guild.id) ?? new Map();
  const currentInvites = await refreshInviteSnapshot(guild);
  if (!currentInvites) return null;

  return currentInvites.find((invite) => (invite.uses ?? 0) > (oldUses.get(invite.code) ?? 0)) ?? null;
}

function getInviteStats(guildId, inviterId) {
  const guildData = getGuildData(guildId);
  const resetAt = guildData.resets[inviterId] ?? 0;
  const invitedMembers = Object.values(guildData.members).filter(
    (member) => member.inviterId === inviterId
      && new Date(member.creditedAt ?? member.joinedAt).getTime() > resetAt,
  );
  const regular = invitedMembers.filter((member) => !member.isFake && !member.left).length;
  const left = invitedMembers.filter((member) => member.left).length;
  const fake = invitedMembers.filter((member) => member.isFake && !member.left).length;
  return { total: regular + left + fake, regular, left, fake };
}

function formatStats(member, stats) {
  return `${member.user.tag} currently has ${stats.total} invites. (${stats.regular} regular, ${stats.left} left, ${stats.fake} fake)`;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  await Promise.all(readyClient.guilds.cache.map((guild) => refreshInviteSnapshot(guild)));
});

client.on(Events.GuildCreate, (guild) => refreshInviteSnapshot(guild));
client.on(Events.InviteCreate, (invite) => refreshInviteSnapshot(invite.guild));
client.on(Events.InviteDelete, (invite) => refreshInviteSnapshot(invite.guild));

client.on(Events.GuildMemberAdd, async (member) => {
  const guildData = getGuildData(member.guild.id);
  const priorRecord = guildData.members[member.id];

  // Someone returning to the server must not create a second invite credit.
  if (priorRecord) {
    priorRecord.left = false;
    priorRecord.lastJoinedAt = new Date().toISOString();
    await saveDatabase();
    await refreshInviteSnapshot(member.guild);
    return;
  }

  const usedInvite = await findUsedInvite(member.guild);
  if (!usedInvite?.inviterId) {
    console.log(`Could not attribute ${member.user.tag}'s join in ${member.guild.name}.`);
    return;
  }

  guildData.members[member.id] = {
    inviterId: usedInvite.inviterId,
    inviteCode: usedInvite.code,
    creditedAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
    lastJoinedAt: new Date().toISOString(),
    left: false,
    isFake: Date.now() - member.user.createdTimestamp < fakeAccountAgeMs,
  };
  await saveDatabase();
});

client.on(Events.GuildMemberRemove, async (member) => {
  const record = getGuildData(member.guild.id).members[member.id];
  if (!record || record.left) return;
  record.left = true;
  record.leftAt = new Date().toISOString();
  await saveDatabase();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const command = message.content.trim().split(/\s+/, 1)[0].toLowerCase();

  if (command === RESET_PREFIX) {
    if (!inviteResetterIds.has(message.author.id)) {
      await message.reply('You are not allowed to reset invite counters.');
      return;
    }

    const target = message.mentions.members.first();
    if (!target) {
      await message.reply('Use `-resetinv @member`.');
      return;
    }

    getGuildData(message.guild.id).resets[target.id] = Date.now();
    await saveDatabase();
    await message.reply(`Reset ${target.user.tag}'s invite counter.`);
    return;
  }

  if (command !== PREFIX) return;

  const remainder = message.content.slice(PREFIX.length).trim();
  const target = message.mentions.members.first() ?? message.member;

  if (remainder && !message.mentions.members.size) {
    await message.reply('Use `-inv` or `-inv @member`.');
    return;
  }

  const stats = getInviteStats(message.guild.id, target.id);
  await message.reply(formatStats(target, stats));
});

await loadDatabase();
client.login(process.env.DISCORD_TOKEN);
