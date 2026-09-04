const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // opcional, para registrar el comando al instante en un solo server
const GROUP_ID = process.env.GROUP_ID; // id de tu grupo de Roblox
const DEFAULT_VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID; // rol base para cualquier verificado (opcional)

// roleMapping.json: { "Nombre EXACTO del rango en Roblox": "id_del_rol_de_discord" }
const ROLE_MAPPING_PATH = path.join(__dirname, 'roleMapping.json');
if (!fs.existsSync(ROLE_MAPPING_PATH)) fs.writeFileSync(ROLE_MAPPING_PATH, '{}');
const roleMapping = JSON.parse(fs.readFileSync(ROLE_MAPPING_PATH, 'utf8'));
// Todos los ids de rol que están mapeados a algún rango, para poder sacárselos
// al usuario antes de darle el que le corresponde ahora (evita que acumule roles viejos).
const allMappedRoleIds = Object.values(roleMapping);

const DB_PATH = path.join(__dirname, 'verified.json');
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '{}');

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Códigos pendientes en memoria: discordId -> { robloxId, robloxUsername, code }
const pending = new Map();

function generateCode() {
  return 'VERIFY-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// --- Funciones para hablar con la API de Roblox ---

async function getRobloxUserByUsername(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;
  return data.data[0]; // { id, name, displayName }
}

async function getRobloxDescription(userId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  const data = await res.json();
  return data.description || '';
}

// Devuelve { rank, name (nombre del rango) } del usuario en GROUP_ID, o null si no es miembro.
async function getGroupRole(userId) {
  if (!GROUP_ID) return null;
  const res = await fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
  const data = await res.json();
  if (!data.data) return null;
  const entry = data.data.find((g) => String(g.group.id) === String(GROUP_ID));
  if (!entry) return null;
  return { rank: entry.role.rank, name: entry.role.name };
}

// A partir del nombre de rango de Roblox, busca el id de rol de Discord correspondiente.
function resolveDiscordRoleId(groupRoleName) {
  if (!groupRoleName) return null;
  return roleMapping[groupRoleName] || null;
}

// --- Cliente de Discord ---

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Publica el panel de verificación de Roblox')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log('Comandos registrados.');
}

client.on('interactionCreate', async (interaction) => {
  try {
    // /panel
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      const embed = new EmbedBuilder()
        .setTitle('🔗 Verificación de Roblox')
        .setDescription('Hacé click en el botón para vincular tu cuenta de Discord con tu cuenta de Roblox.')
        .setColor(0x00b2ff);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_verify')
          .setLabel('Verificar cuenta')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('✅')
      );

      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }

    // Botón: abrir modal pidiendo el username de Roblox
    if (interaction.isButton() && interaction.customId === 'start_verify') {
      const modal = new ModalBuilder()
        .setCustomId('verify_modal')
        .setTitle('Verificar cuenta de Roblox');

      const usernameInput = new TextInputBuilder()
        .setCustomId('roblox_username')
        .setLabel('Tu nombre de usuario de Roblox')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
      await interaction.showModal(modal);
      return;
    }

    // Modal enviado: generar código y pedir confirmación
    if (interaction.isModalSubmit() && interaction.customId === 'verify_modal') {
      const username = interaction.fields.getTextInputValue('roblox_username').trim();

      const robloxUser = await getRobloxUserByUsername(username);
      if (!robloxUser) {
        await interaction.reply({
          content: `❌ No encontré ningún usuario de Roblox llamado **${username}**. Revisá que esté bien escrito.`,
          ephemeral: true,
        });
        return;
      }

      const code = generateCode();
      pending.set(interaction.user.id, { robloxId: robloxUser.id, robloxUsername: robloxUser.name, code });

      const embed = new EmbedBuilder()
        .setTitle('Un paso más 👀')
        .setDescription(
          `1. Andá a tu perfil de Roblox: https://www.roblox.com/users/${robloxUser.id}/profile\n` +
          `2. Editá tu **"About Me"** y pegá este código:\n\n\`${code}\`\n\n` +
          `3. Guardá los cambios y volvé acá y tocá **"Ya lo puse"**.\n\n` +
          `_(Podés borrar el código de tu perfil después de verificarte)_`
        )
        .setColor(0xffcc00);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('confirm_verify')
          .setLabel('Ya lo puse')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🔄')
      );

      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      return;
    }

    // Confirmar verificación
    if (interaction.isButton() && interaction.customId === 'confirm_verify') {
      const data = pending.get(interaction.user.id);
      if (!data) {
        await interaction.reply({
          content: '❌ No tenés ninguna verificación pendiente. Empezá de nuevo con el botón "Verificar cuenta".',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const description = await getRobloxDescription(data.robloxId);
      if (!description.includes(data.code)) {
        await interaction.editReply(
          '❌ No encontré el código en tu "About Me" de Roblox todavía. Asegurate de haberlo guardado y probá de nuevo en unos segundos.'
        );
        return;
      }

      // Ver el rango que tiene en el grupo de Roblox
      const groupRole = await getGroupRole(data.robloxId);
      const targetRoleId = resolveDiscordRoleId(groupRole?.name) || DEFAULT_VERIFIED_ROLE_ID || null;

      // Guardar la verificación
      const db = loadDB();
      db[interaction.user.id] = {
        robloxId: data.robloxId,
        robloxUsername: data.robloxUsername,
        groupRank: groupRole?.rank ?? null,
        groupRoleName: groupRole?.name ?? null,
        verifiedAt: new Date().toISOString(),
      };
      saveDB(db);
      pending.delete(interaction.user.id);

      // Asignar el rol correcto y sacar los de rangos viejos
      const member = interaction.member;
      try {
        const rolesToRemove = allMappedRoleIds.filter(
          (id) => id !== targetRoleId && member.roles.cache.has(id)
        );
        if (rolesToRemove.length) await member.roles.remove(rolesToRemove);
        if (targetRoleId) await member.roles.add(targetRoleId);
        await member.setNickname(data.robloxUsername).catch(() => {});
      } catch (e) {
        console.error('No se pudo asignar rol/apodo:', e.message);
      }

      const rangoTexto = groupRole
        ? `Tu rango en el grupo es **${groupRole.name}**.`
        : GROUP_ID
        ? 'No sos miembro del grupo de Roblox configurado, así que se te asignó el rol por defecto.'
        : '';

      await interaction.editReply(
        `✅ ¡Listo! Tu cuenta de Discord quedó vinculada con **${data.robloxUsername}** en Roblox. ${rangoTexto}`
      );
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = { content: '⚠️ Ocurrió un error inesperado. Intentá de nuevo.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply(msg);
    }
  }
});

registerCommands().then(() => client.login(TOKEN));
