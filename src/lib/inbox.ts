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
