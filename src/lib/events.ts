import type { Prisma } from "@prisma/client";
import { db } from "./db";

// Every change to a lead lands on its timeline, so the team can see what the AI and the automations did.
export async function logEvent(
  leadId: string,
  type: string,
  actor: string,
  summary: string,
  data?: Prisma.InputJsonValue,
) {
  return db.leadEvent.create({ data: { leadId, type, actor, summary, data } });
}
