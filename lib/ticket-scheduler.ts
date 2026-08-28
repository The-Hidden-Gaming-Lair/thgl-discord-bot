import { EmbedBuilder } from "discord.js";
import { TICKET_CHANNEL_ID } from "./channels";
import {
  archiveTicketThread,
  buildClosedEmbed,
  computeInactivityAction,
  deriveActivity,
  getTicketParentChannel,
  isWarningMessage,
  TICKET_WARNING_FOOTER,
} from "./tickets";

/**
 * Periodic ticket maintenance: warn inactive tickets, then auto-close them.
 *
 * Env:
 *   TICKET_SCHEDULER_ENABLED      "false" to disable (default on; also inert
 *                                 while TICKET_CHANNEL_ID is unset)
 *   TICKET_SCHEDULER_INTERVAL_MS  scan interval, default 21600000 (6 h)
 *   TICKET_WARN_AFTER_MS          inactivity before warning, default 5 d
 *   TICKET_CLOSE_AFTER_MS         inactivity before close, default 7 d
 *                                 (measured from last non-warning message;
 *                                 must be > TICKET_WARN_AFTER_MS)
 */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WARN_AFTER_MS = 5 * 24 * 60 * 60 * 1000;
const DEFAULT_CLOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

let running = false;

function buildWarningEmbed(remainingMs: number): EmbedBuilder {
  const days = Math.max(1, Math.round(remainingMs / (24 * 60 * 60 * 1000)));
  return new EmbedBuilder()
    .setDescription(
      `This ticket has been inactive for a while and will be closed ` +
        `automatically in about ${days} day(s). Reply to keep it open.`,
    )
    .setColor(0xfee75c)
    .setFooter({ text: TICKET_WARNING_FOOTER });
}

export async function runTicketMaintenance() {
  if (running) {
    return;
  }
  running = true;
  try {
    const warnAfterMs =
      Number(process.env.TICKET_WARN_AFTER_MS) || DEFAULT_WARN_AFTER_MS;
    const closeAfterMs =
      Number(process.env.TICKET_CLOSE_AFTER_MS) || DEFAULT_CLOSE_AFTER_MS;

    const channel = getTicketParentChannel();
    const active = await channel.threads.fetchActive();

    for (const thread of active.threads.values()) {
      if (thread.parentId !== TICKET_CHANNEL_ID) {
        continue;
      }
      try {
        const fetched = await thread.messages.fetch({ limit: 10 });
        const infos = [...fetched.values()]
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .map((message) => ({
            createdTimestamp: message.createdTimestamp,
            isWarning: isWarningMessage(message),
          }));
        const { lastActivityMs, warned } = deriveActivity(
          infos,
          thread.createdTimestamp ?? Date.now(),
        );
        const action = computeInactivityAction({
          lastActivityMs,
          warned,
          nowMs: Date.now(),
          warnAfterMs,
          closeAfterMs,
        });
        if (action === "warn") {
          await thread.send({
            embeds: [buildWarningEmbed(closeAfterMs - warnAfterMs)],
          });
        } else if (action === "close") {
          await thread.send({ embeds: [buildClosedEmbed("auto-close (inactivity)")] });
          await archiveTicketThread(thread, { closedBy: "auto-close" });
        }
      } catch (err) {
        console.error(`[tickets] maintenance failed for thread ${thread.id}`, err);
      }
    }
  } catch (err) {
    console.error("[tickets] maintenance run failed", err);
  } finally {
    running = false;
  }
}

export function startTicketScheduler() {
  if (!TICKET_CHANNEL_ID) {
    return;
  }
  if (process.env.TICKET_SCHEDULER_ENABLED === "false") {
    console.log("[tickets] scheduler disabled (TICKET_SCHEDULER_ENABLED=false)");
    return;
  }
  const interval =
    Number(process.env.TICKET_SCHEDULER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  setTimeout(() => {
    void runTicketMaintenance();
    setInterval(() => void runTicketMaintenance(), interval);
  }, STARTUP_DELAY_MS);
  console.log(
    `[tickets] scheduler armed (every ${Math.round(interval / 60000)} min)`,
  );
}
