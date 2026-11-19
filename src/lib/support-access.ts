import type { Prisma } from "@prisma/client";
import { requireArea } from "./access";
import { db } from "./db";

type Who = { id: string; role: string };

/**
 * Who sees what in Suporte: the owner and managers see every number and the team's numbers;
 * an attendant (seller) sees only the conversations of the numbers they answer.
 */
export async function supportScope(user: Who) {
  const attendant = await db.supportAttendant.findUnique({ where: { userId: user.id } });
  const monitor = user.role !== "SELLER";
  const chatWhere: Prisma.SupportChatWhereInput =
    !monitor && attendant ? { number: { active: true, attendants: { some: { id: attendant.id } } } } : { number: { active: true } };
  return { attendant, monitor, owner: user.role === "OWNER", chatWhere };
}

export async function supportViewer() {
  const user = await requireArea("suporte");
  return { user, ...(await supportScope(user)) };
}

/** What the open inbox compares to know something changed: newest chat and how many are waiting. */
export async function inboxVersion(chatWhere: Prisma.SupportChatWhereInput) {
  const [latest, waiting] = await Promise.all([
    db.supportChat.findFirst({ where: chatWhere, orderBy: { lastMessageAt: "desc" }, select: { id: true, lastMessageAt: true } }),
    db.supportChat.count({ where: { ...chatWhere, waitingSince: { not: null } } }),
  ]);
  return { version: `${latest?.id ?? ""}:${latest?.lastMessageAt.getTime() ?? 0}:${waiting}`, waiting };
}
