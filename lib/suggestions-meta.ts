import { readFileSync } from "node:fs";
import { GAME_CONFIGS } from "./game-roles";

/**
 * Game + category association for suggestions-issues forum posts.
 *
 * The forum's per-game tags are being replaced by category tags (Bug /
 * Suggestion / Question + Coding) — the 20-tag cap can't fit one tag per game.
 * Game association order of precedence:
 *   1. live game tags on the thread (pre-cutover threads / transition window)
 *   2. the committed snapshot (data/suggestions-snapshot.json) taken before
 *      the cutover — authoritative for all historical threads
 *   3. keyword detection on title+content against the game configs
 * Category precedence: live category tag > snapshot > heuristic.
 */

/** Forum tag name -> game slug (canonical discordId where one exists). */
export const TAG_TO_GAME: Record<string, string> = {
  "Songs of Conquest": "songs-of-conquest",
  "Diablo 4": "diablo4",
  "Palia Map": "palia",
  "Sons Of The Forest": "sons-of-the-forest-map",
  "Aeternum Tracker": "aeternum-tracker",
  "Palia Tracker": "palia-tracker",
  "Palworld": "palworld",
  "Once Human": "once-human",
  "Pax Dei": "pax-dei",
  "Wuthering Waves": "wuthering-waves",
  "Satisfactory": "satisfactory",
  "Infinity Nikki": "infinity-nikki",
  "Avowed": "avowed",
  "Dune: Awakening": "dune-awakening",
  "BPSR": "blue-protocol-star-resonance",
  "RuneScape": "rsdragonwilds",
  "Starsand Island": "starsand-island",
  "Crimson Desert": "crimson-desert",
  "Gothic 1 Remake": "gothic-1-remake",
  // "Coding" is a topic, not a game.
};

export type SuggestionCategory = "bug" | "suggestion" | "question";

export const CATEGORY_TAG_NAMES: Record<string, SuggestionCategory> = {
  Bug: "bug",
  Suggestion: "suggestion",
  Question: "question",
};

const BUG_RE =
  /\b(bugs?|issues?|error|crash\w*|broken|incorrect|invalid|not (working|showing|displayed|visible)|doesn'?t work|won'?t (load|start|work)|can'?t|cannot|fails?|failed|wrong|glitch\w*|freez\w*|stuck|missing)\b/i;
const QUESTION_START_RE =
  /^(how|why|what|where|when|which|is |are |can |could |does |do |should )/i;

/** Deterministic Bug/Question/Suggestion heuristic (see the Phase 3 plan). */
export function classifyCategory(
  title: string,
  content: string,
): { category: SuggestionCategory; reason: string } {
  const text = `${title}\n${content.slice(0, 500)}`;
  const bugHit = text.match(BUG_RE);
  if (bugHit) return { category: "bug", reason: `matched "${bugHit[0]}"` };
  if (title.trim().endsWith("?")) return { category: "question", reason: "title ends with ?" };
  if (QUESTION_START_RE.test(title.trim())) {
    return { category: "question", reason: "interrogative title start" };
  }
  return { category: "suggestion", reason: "default" };
}

/** Keyword fallback: match canonical game titleKeywords in title+content. */
export function detectGames(title: string, content: string): string[] {
  const text = `${title}\n${content.slice(0, 500)}`.toLowerCase();
  const hits = new Set<string>();
  for (const config of GAME_CONFIGS) {
    for (const keyword of config.titleKeywords ?? []) {
      if (text.includes(keyword)) {
        hits.add(config.name);
        break;
      }
    }
  }
  return [...hits];
}

interface SnapshotMeta {
  games: string[];
  category: SuggestionCategory;
}

let snapshotById: Map<string, SnapshotMeta> | null | undefined;

function loadSnapshot(): Map<string, SnapshotMeta> | null {
  if (snapshotById !== undefined) return snapshotById;
  try {
    const raw = JSON.parse(
      readFileSync(new URL("../data/suggestions-snapshot.json", import.meta.url), "utf8"),
    );
    snapshotById = new Map(
      (raw.threads ?? []).map((t: any) => [
        t.id,
        { games: t.games ?? [], category: t.category ?? "suggestion" },
      ]),
    );
    console.log(`[suggestions-meta] snapshot loaded (${snapshotById.size} threads)`);
  } catch (err) {
    snapshotById = null;
    console.warn(
      `[suggestions-meta] snapshot unavailable, using live tags + keyword detection only: ${(err as Error).message}`,
    );
  }
  return snapshotById;
}

export function getSuggestionMeta(input: {
  threadId: string;
  title: string;
  content: string;
  appliedTagNames: string[];
}): { games: string[]; category: SuggestionCategory } {
  let liveCategory: SuggestionCategory | null = null;
  const liveGames: string[] = [];
  for (const name of input.appliedTagNames) {
    const cat = CATEGORY_TAG_NAMES[name];
    if (cat) liveCategory = liveCategory ?? cat;
    const game = TAG_TO_GAME[name];
    if (game) liveGames.push(game);
  }

  const snap = loadSnapshot()?.get(input.threadId);

  const games =
    liveGames.length > 0
      ? liveGames
      : snap && snap.games.length > 0
        ? snap.games
        : detectGames(input.title, input.content);

  const category =
    liveCategory ??
    snap?.category ??
    classifyCategory(input.title, input.content).category;

  return { games: [...new Set(games)], category };
}
