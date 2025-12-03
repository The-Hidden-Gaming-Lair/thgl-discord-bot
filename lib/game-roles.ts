/**
 * Mapping of game names to their role IDs for filtering messages in the central app-updates channel
 *
 * When a role is mentioned in the app-updates channel, we can use this mapping to identify
 * which game the update is for and return it in the appropriate API endpoint.
 */

export interface GameConfig {
  /** The game/channel name used in the API route */
  name: string;
  /** The Discord channel ID for dedicated updates (if exists) */
  channelId: string;
  /** Role ID(s) that are pinged for this game in the central app-updates channel */
  roleIds?: string[];
  /** Alternative names/keywords to match in message titles */
  titleKeywords?: string[];
}

/**
 * Central app-updates channel ID where all game updates will be posted
 */
export const CENTRAL_UPDATES_CHANNEL_ID = "1166078913756270702";

/**
 * Game configurations with their channels and role mappings
 * Note: roleIds will need to be populated once roles are actually mentioned in messages
 */
export const GAME_CONFIGS: GameConfig[] = [
  {
    name: "announcements",
    channelId: "815508847099117588",
    titleKeywords: ["announcement"],
  },
  {
    name: "aeternum-map",
    channelId: "896014490808745994",
    roleIds: ["1105201503582568508"],
    titleKeywords: ["aeternum map", "new world map"],
  },
  {
    name: "aeternum-tracker",
    channelId: "1159116919249575978",
    titleKeywords: ["aeternum tracker"],
  },
  {
    name: "diablo4",
    channelId: "1114136338036441201",
    titleKeywords: ["diablo 4", "diablo iv"],
  },
  {
    name: "palia",
    channelId: "1148606632494895145",
    titleKeywords: ["palia"],
  },
  {
    name: "palia-tracker",
    channelId: "1151592050995773520",
    titleKeywords: ["palia tracker"],
  },
  {
    name: "diablo4-companion",
    channelId: "1124004157007867924",
    titleKeywords: ["diablo 4 companion", "diablo iv companion"],
  },
  {
    name: "new-world-companion",
    channelId: "1105189246769311774",
    roleIds: ["1105201503582568508"],
    titleKeywords: ["new world companion"],
  },
  {
    name: "sons-of-the-forest-map",
    channelId: "1086576689745772554",
    titleKeywords: ["sons of the forest"],
  },
  {
    name: "arkesia-map",
    channelId: "944106743036796928",
    titleKeywords: ["arkesia", "lost ark"],
  },
  {
    name: "trophy-hunter",
    channelId: "543841073676681217",
    titleKeywords: ["trophy hunter"],
  },
  {
    name: "songs-of-conquest",
    channelId: "976935814900645939",
    titleKeywords: ["songs of conquest"],
  },
  {
    name: "hogwarts-legacy-map",
    channelId: "1064862000150237264",
    titleKeywords: ["hogwarts legacy"],
  },
  {
    name: "skeleton",
    channelId: "918959476734824468",
    titleKeywords: ["skeleton"],
  },
  {
    name: "palworld",
    channelId: "1198571864755277895",
    titleKeywords: ["palworld"],
  },
  {
    name: "once-human",
    channelId: "1196793877458321458",
    titleKeywords: ["once human"],
  },
  {
    name: "night-crows",
    channelId: "1217421560386818088",
    titleKeywords: ["night crows"],
  },
  {
    name: "seekers-of-skyveil",
    channelId: "1225105797038473226",
    titleKeywords: ["seekers of skyveil"],
  },
  {
    name: "pax-dei",
    channelId: "1234393071299596309",
    titleKeywords: ["pax dei"],
  },
  {
    name: "wuthering-waves",
    channelId: "1247540622835974257",
    roleIds: ["1247541675430248588"],
    titleKeywords: ["wuthering waves"],
  },
  {
    name: "satisfactory",
    channelId: "1302557334446407700",
    titleKeywords: ["satisfactory"],
  },
  {
    name: "infinity-nikki",
    channelId: "1313829928856322048",
    roleIds: ["1313828748113739827"],
    titleKeywords: ["infinity nikki"],
  },
  {
    name: "avowed",
    channelId: "1339985812430917706",
    titleKeywords: ["avowed"],
  },
  {
    name: "dune-awakening",
    channelId: "1376831284411629629",
    roleIds: ["1376831895501017099"],
    titleKeywords: ["dune: awakening", "dune awakening"],
  },
  {
    name: "chrono-odyssey",
    channelId: "1386716236976492694",
    titleKeywords: ["chrono odyssey"],
  },
  {
    name: "soulframe",
    channelId: "1400750444720029726",
    roleIds: ["1400750833381019698"],
    titleKeywords: ["soulframe"],
  },
  {
    name: "grounded2",
    channelId: "1400751543573282876",
    titleKeywords: ["grounded 2", "grounded ii"],
  },
  {
    name: "blue-protocol-star-resonance",
    channelId: "1425525855509151824",
    roleIds: ["1425524646723321890"],
    titleKeywords: ["blue protocol: star resonance", "blue protocol star resonance"],
  },
  {
    name: "duet-night-abyss",
    channelId: "", // No dedicated channel - uses central channel only
    roleIds: ["1435978166257717349"],
    titleKeywords: ["duet night abyss"],
  },
  {
    name: "thgl-companion-app",
    channelId: "", // No dedicated channel - uses central channel only
    roleIds: ["1445860743181369509"],
    titleKeywords: ["thgl companion app", "companion app"],
  },
];

/**
 * Get game config by name
 */
export function getGameConfig(gameName: string): GameConfig | undefined {
  return GAME_CONFIGS.find((config) => config.name === gameName);
}

/**
 * Find game by role ID
 */
export function findGameByRoleId(roleId: string): GameConfig | undefined {
  return GAME_CONFIGS.find((config) =>
    config.roleIds?.includes(roleId)
  );
}

/**
 * Find game by checking if message title contains any of the game's keywords
 */
export function findGameByTitle(title: string): GameConfig | undefined {
  const lowerTitle = title.toLowerCase();
  return GAME_CONFIGS.find((config) =>
    config.titleKeywords?.some((keyword) => lowerTitle.includes(keyword))
  );
}
