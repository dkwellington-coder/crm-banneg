import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

/** The audio of a message, only for people signed in to the CRM. */
export async function GET(_request: Request, ctx: RouteContext<"/api/media/[id]">) {
  if (!(await currentUser())) return new Response("Entre no CRM.", { status: 401 });
  const { id } = await ctx.params;
  const media = await db.messageMedia.findUnique({ where: { messageId: id } });
  if (!media) return new Response("Áudio não encontrado.", { status: 404 });
  return new Response(Buffer.from(media.data), {
    headers: { "Content-Type": media.mimeType, "Cache-Control": "private, max-age=86400" },
  });
}
