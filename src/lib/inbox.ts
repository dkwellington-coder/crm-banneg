import type { Direction, MessageStatus } from "@prisma/client";
import { db } from "./db";

export type LastMessage = {
  leadId: string;
  body: string;
  author: string;
  direction: Direction;
  status: MessageStatus;
  error: string | null;
  createdAt: Date;
};

/**
 * The last message of each lead in one query. A `messages: { take: 1 }` include reads every message
 * of every lead on the screen and keeps one, which gets slower as the conversations grow.
 */
export async function lastMessages(leadIds: string[]) {
  if (!leadIds.length) return new Map<string, LastMessage>();
  const rows = await db.$queryRaw<LastMessage[]>`
    SELECT DISTINCT ON ("leadId") "leadId", body, author, direction, status, error, "createdAt" FROM "Message"
    WHERE "leadId" = ANY(${leadIds})
    ORDER BY "leadId", "createdAt" DESC`;
  return new Map(rows.map((r) => [r.leadId, r]));
}

/** The latest WhatsApp message of the leads that talked most recently, newest first. */
export function latestConversations(limit: number) {
  return db.$queryRaw<LastMessage[]>`
    SELECT * FROM (
      SELECT DISTINCT ON ("leadId") "leadId", body, author, direction, status, error, "createdAt" FROM "Message"
      WHERE channel = 'WHATSAPP' ORDER BY "leadId", "createdAt" DESC
    ) last ORDER BY "createdAt" DESC LIMIT ${limit}`;
}

type MessageMark = { id: string; status: MessageStatus; body: string };

/**
 * A short mark of what the lead's page shows at the end of the conversation: the newest messages
 * (with their status, so "entregue" and "lida" show up, and their size, so an audio's transcript does)
 * and the newest AI and automation steps. It moves whenever there is something new to see.
 */
export function versionOf(messages: MessageMark[], events: { id: string }[]) {
  return [...messages.map((m) => `${m.id}:${m.status}:${m.body.length}`), ...events.map((e) => e.id)].sort().join("|");
}

export const VERSION_MESSAGES = 5;
export const VERSION_EVENTS = 3;

/** The open conversation asks for this every few seconds and reloads only when it moves. */
export async function conversationVersion(leadId: string) {
  const [messages, events] = await Promise.all([
    db.message.findMany({ where: { leadId }, orderBy: { createdAt: "desc" }, take: VERSION_MESSAGES, select: { id: true, status: true, body: true } }),
    db.leadEvent.findMany({ where: { leadId }, orderBy: { createdAt: "desc" }, take: VERSION_EVENTS, select: { id: true } }),
  ]);
  return versionOf(messages, events);
}
