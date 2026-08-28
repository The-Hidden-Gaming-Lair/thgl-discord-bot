export const UPDATES_CHANNELS: {
  name: string;
  id: string;
}[] = [
  {
    name: "announcements",
    id: "815508847099117588",
  },
  {
    name: "app-updates",
    id: "1166078913756270702",
  },
  {
    name: "aeternum-map",
    id: "896014490808745994",
  },
  {
    name: "aeternum-tracker",
    id: "1159116919249575978",
  },
  {
    name: "diablo4",
    id: "1114136338036441201",
  },
  {
    name: "palia",
    id: "1148606632494895145",
  },
  {
    name: "palia-tracker",
    id: "1151592050995773520",
  },
  {
    name: "diablo4-companion",
    id: "1124004157007867924",
  },
  {
    name: "new-world-companion",
    id: "1105189246769311774",
  },
  {
    name: "sons-of-the-forest-map",
    id: "1086576689745772554",
  },
  {
    name: "arkesia-map",
    id: "944106743036796928",
  },
  {
    name: "trophy-hunter",
    id: "543841073676681217",
  },
  {
    name: "songs-of-conquest",
    id: "976935814900645939",
  },
  {
    name: "hogwarts-legacy-map",
    id: "1064862000150237264",
  },
  {
    name: "skeleton",
    id: "918959476734824468",
  },
  {
    name: "palworld",
    id: "1198571864755277895",
  },
  {
    name: "once-human",
    id: "1196793877458321458",
  },
  {
    name: "night-crows",
    id: "1217421560386818088",
  },
  {
    name: "seekers-of-skyveil",
    id: "1225105797038473226",
  },
  {
    name: "pax-dei",
    id: "1234393071299596309",
  },
  {
    name: "wuthering-waves",
    id: "1247540622835974257",
  },
  {
    name: "satisfactory",
    id: "1302557334446407700",
  },
  {
    name: "infinity-nikki",
    id: "1313829928856322048",
  },
  {
    name: "avowed",
    id: "1339985812430917706",
  },
  {
    name: "dune-awakening",
    id: "1376831284411629629",
  },
  {
    name: "chrono-odyssey",
    id: "1386716236976492694",
  },
  {
    name: "soulframe",
    id: "1400750444720029726",
  },
  {
    name: "grounded2",
    id: "1400751543573282876",
  },
  {
    name: "blue-protocol-star-resonance",
    id: "1425525855509151824",
  },
  {
    name: "duet-night-abyss",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "thgl-companion-app",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "rsdragonwilds",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "starsand-island",
    id: "", // No dedicated updates channel - uses central channel only
  },
  {
    name: "crimson-desert",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "soulmask",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "homm-olden-era",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "conan-exiles",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "gothic-1-remake",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "subnautica-2",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "witchspire",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "neverness-to-everness",
    id: "", // No dedicated channel - uses central channel only
  },
  {
    name: "dragonsword-awakening",
    id: "", // No dedicated channel - uses central channel only
  },
];

export const SUGGESTIONS_ISSUES_CHANNEL = {
  name: "suggestions-issues",
  id: "1021543411293106217",
};

// Forum channel mirrored from the web FAQ (faq-entries.ts on www.th.gl).
// Threads here are created/updated/removed by the web→Discord FAQ sync
// (lib/faq.ts). The web is the single source of truth.
export const FAQ_CHANNEL = {
  name: "faq",
  id: "1038352744341311528",
};

export const INFO_CHANNELS: {
  name: string;
  id: string;
}[] = [
  {
    name: "aeternum-map",
    id: "1105082545860771870",
  },
  {
    name: "aeternum-tracker",
    id: "1159115209911308418",
  },
  {
    name: "diablo4",
    id: "1114135497351102554",
  },
  {
    name: "palia",
    id: "1148606598529429594",
  },
  {
    name: "palia-tracker",
    id: "1151591363180232759",
  },
  {
    name: "diablo4-companion",
    id: "1124004114536349821",
  },
  {
    name: "new-world-companion",
    id: "1105117768463954021",
  },
  {
    name: "sons-of-the-forest-map",
    id: "1105087197545255012",
  },
  {
    name: "arkesia-map",
    id: "1105083909970083950",
  },
  {
    name: "trophy-hunter",
    id: "1105084713061851238",
  },
  {
    name: "songs-of-conquest",
    id: "1105086603522736248",
  },
  {
    name: "hogwarts-legacy-map",
    id: "1105085426940788737",
  },
  {
    name: "new-world-influence-updates",
    id: "1105049554799312917",
  },
  {
    name: "skeleton",
    id: "1105086068866420798",
  },
  {
    name: "palworld",
    id: "1198571785587798126",
  },
  {
    name: "once-human",
    id: "1196793835523674132",
  },
  {
    name: "night-crows",
    id: "1217421510260559892",
  },
  {
    name: "seekers-of-skyveil",
    id: "1225105774326579221",
  },
  {
    name: "pax-dei",
    id: "1234393041318707292",
  },
  {
    name: "wuthering-waves",
    id: "1247540599033430138",
  },
  {
    name: "satisfactory",
    id: "1302557304822173706",
  },
  {
    name: "infinity-nikki",
    id: "1313829213488549909",
  },
  {
    name: "avowed",
    id: "1339985779669336166",
  },
  {
    name: "dune-awakening",
    id: "1376831252698497055",
  },
  {
    name: "chrono-odyssey",
    id: "1386715922500157571",
  },
  {
    name: "soulframe",
    id: "1400750363992133632",
  },
  {
    name: "grounded2",
    id: "1400751489131216937",
  },
  {
    name: "blue-protocol-star-resonance",
    id: "1425525600831143946",
  },
];

// --- Ticket system (docs/superpowers/specs/2026-08-27-ticket-system-design.md) ---
// Staff/moderator role: grants ManageThreads visibility on the panel channel
// and is the role each TICKET_STAFF_USER_IDS entry must hold to be added.
export const TICKET_STAFF_ROLE_ID = "1173945621963604069";
// Text channel hosting the ticket panel + private ticket threads.
// Empty = ticket system inert. Production: 1092316764081225788 (📕・support-ticket),
// set ONLY in the server docker-compose (multi-instance kill-switch, see CLAUDE.md).
export const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID ?? "";
// Staff-only channel receiving one embed per ticket event. Empty = logging off.
export const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID ?? "";
// Staff members silently added to every ticket thread. Env override:
// TICKET_STAFF_USER_IDS="id1,id2". Each id is re-verified against the live
// guild (must still hold TICKET_STAFF_ROLE_ID) before being added, so a stale
// entry can never join a ticket. An explicit list is used because enumerating
// role members needs the GuildMembers privileged intent, which requires
// Discord verification review at this bot's scale.
export const TICKET_STAFF_USER_IDS: string[] = process.env.TICKET_STAFF_USER_IDS
  ? process.env.TICKET_STAFF_USER_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [
      "311400587445141504", // devleon
      "197529782672424960", // winderine
      "763566602124918804", // mangogamr
      "394481834592829441", // .uthar
      "139320165614616577", // .hava.
      "513093031830880257", // borys21
      "325404820347420672", // airakokosuki
      "102498939755827200", // daleth
    ];
