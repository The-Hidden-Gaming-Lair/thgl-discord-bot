import {
  EmbedBuilder,
  Events,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";

/**
 * `/status` and `/version` slash commands.
 *
 * /status mirrors https://www.th.gl/status via the existing JSON feed
 * (https://www.th.gl/api/status — full StatusDocument: components, game
 * integrations, incidents). No web-repo changes were needed.
 *
 * /version shows the canonical latest app versions:
 * - THGL Companion App: https://app.th.gl/version.txt (the auto-updater's
 *   own version marker — exactly what installed apps update towards)
 * - Website build: https://www.th.gl/api/build-id (git sha)
 * Overwolf per-game app versions have no runtime source yet (manifests live
 * only in the monorepo) — omitted until one exists.
 */

const STATUS_URL = "https://www.th.gl/api/status";
const STATUS_PAGE = "https://www.th.gl/status";
const APP_VERSION_URL = "https://app.th.gl/version.txt";
const BUILD_ID_URL = "https://www.th.gl/api/build-id";
const INSTALLER_URL = "https://app.th.gl/THGL_Installer.exe";

type StatusState = "operational" | "degraded" | "outage";

type StatusDocument = {
  state: StatusState;
  updatedAt: number; // unix seconds
  components: {
    id: string;
    label: string;
    state: StatusState;
    detail: string | null;
    uptime24h: number | null;
  }[];
  games: {
    id: string;
    label: string;
    thglEvents: StatusState | null;
    owEvents: StatusState | null;
    liveMode: string | null;
  }[];
  incidents: {
    title: string;
    severity?: string;
    resolvedAt?: number | null;
  }[];
  provisional?: boolean;
};

const STATE_EMOJI: Record<StatusState, string> = {
  operational: "🟢",
  degraded: "🟡",
  outage: "🔴",
};

const STATE_COLOR: Record<StatusState, number> = {
  operational: 0x57f287,
  degraded: 0xfee75c,
  outage: 0xed4245,
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": "thgl-discord-bot/status-command" },
  });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const doc = await fetchJson<StatusDocument>(STATUS_URL);

  const badComponents = doc.components.filter((c) => c.state !== "operational");
  const badGames = doc.games.filter(
    (g) =>
      (g.thglEvents && g.thglEvents !== "operational") ||
      (g.owEvents && g.owEvents !== "operational"),
  );
  const activeIncidents = doc.incidents.filter((i) => !i.resolvedAt);

  const lines: string[] = [];

  lines.push(
    badComponents.length === 0
      ? `🟢 All ${doc.components.length} services operational`
      : badComponents
          .map(
            (c) =>
              `${STATE_EMOJI[c.state]} **${c.label}**: ${c.state}${c.detail ? ` — ${c.detail}` : ""}`,
          )
          .join("\n"),
  );

  if (badGames.length > 0) {
    lines.push(
      "\n**Game integrations with issues:**\n" +
        badGames
          .map((g) => {
            const parts = [
              g.thglEvents && g.thglEvents !== "operational"
                ? `THGL events ${STATE_EMOJI[g.thglEvents]}`
                : null,
              g.owEvents && g.owEvents !== "operational"
                ? `Overwolf events ${STATE_EMOJI[g.owEvents]}`
                : null,
            ].filter(Boolean);
            return `• **${g.label}**: ${parts.join(", ")}${g.liveMode ? ` — ${g.liveMode}` : ""}`;
          })
          .join("\n"),
    );
  } else {
    lines.push(`🟢 All ${doc.games.length} game integrations operational`);
  }

  if (activeIncidents.length > 0) {
    lines.push(
      "\n**Active incidents:**\n" +
        activeIncidents
          .map((i) => `⚠️ ${i.title}${i.severity ? ` (${i.severity})` : ""}`)
          .join("\n"),
    );
  }

  lines.push(`\n📊 [Full status page](${STATUS_PAGE})`);

  const embed = new EmbedBuilder()
    .setTitle(
      `${STATE_EMOJI[doc.state]} th.gl status: ${doc.state}${doc.provisional ? " (provisional)" : ""}`,
    )
    .setDescription(lines.join("\n"))
    .setColor(STATE_COLOR[doc.state])
    .setTimestamp(doc.updatedAt * 1000);

  await interaction.editReply({ embeds: [embed] });
}

async function handleVersion(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const [appVersion, buildId] = await Promise.all([
    fetch(APP_VERSION_URL, {
      headers: { "user-agent": "thgl-discord-bot/status-command" },
    })
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => text?.trim() || null)
      .catch(() => null),
    fetchJson<{ sha: string }>(BUILD_ID_URL).catch(() => null),
  ]);

  const lines = [
    appVersion
      ? `🖥️ **THGL Companion App**: v${appVersion} ([installer](${INSTALLER_URL}))`
      : "🖥️ **THGL Companion App**: version unavailable",
    buildId
      ? `🌐 **Website (th.gl)**: build \`${buildId.sha.slice(0, 8)}\``
      : "🌐 **Website (th.gl)**: build unavailable",
    "🎮 **Overwolf apps**: versioned per app in the Overwolf store",
  ];

  const embed = new EmbedBuilder()
    .setTitle("Current versions")
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

export function registerStatusCommands(client: Client) {
  const guild = client.guilds.cache.first();
  if (!guild) {
    return;
  }

  void guild.commands
    .create({
      name: "status",
      description: "Are th.gl services and game integrations up right now?",
    })
    .then(() => console.log("[status-command] /status registered"))
    .catch((err) => console.error("[status-command] registration failed", err));

  void guild.commands
    .create({
      name: "version",
      description: "Current THGL app and website versions",
    })
    .then(() => console.log("[status-command] /version registered"))
    .catch((err) => console.error("[status-command] registration failed", err));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    try {
      if (interaction.commandName === "status") {
        await handleStatus(interaction);
      } else if (interaction.commandName === "version") {
        await handleVersion(interaction);
      }
    } catch (err) {
      console.error("[status-command] interaction failed", err);
      if (interaction.isRepliable()) {
        try {
          if (interaction.deferred) {
            await interaction.editReply({
              content: "Couldn't fetch that right now — please try again.",
            });
          } else if (!interaction.replied) {
            await interaction.reply({
              content: "Couldn't fetch that right now — please try again.",
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch {
          // Nothing sensible left to do.
        }
      }
    }
  });
}
