import { currentUser } from "@/lib/auth";
import { canSee } from "@/lib/areas";
import { db } from "@/lib/db";
import { supportScope } from "@/lib/support-access";
import { fetchSupportMedia } from "@/lib/support";
import { driveFileName, supportDrive } from "@/lib/support-drive";
import { accessTokenFrom } from "@/lib/google";

/**
 * The file of a support message (audio, photo, PDF, video), for whoever sees that conversation. It comes from the
 * WhatsApp server's disk; if the server is down, from the copy in the Google Drive.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/suporte/midia/[id]">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  if (!canSee(user, "suporte")) return Response.json({ error: "Sem acesso a esta tela." }, { status: 403 });
  const { id } = await ctx.params;
  const { chatWhere } = await supportScope(user);
  const m = await db.supportMessage.findFirst({ where: { id, chat: chatWhere }, include: { chat: { include: { number: true } } } });
  if (!m?.externalId || !m.mediaMime) return Response.json({ error: "Arquivo não encontrado." }, { status: 404 });

  const download = new URL(request.url).searchParams.has("baixar");
  const name = driveFileName(m, m.chat.name || m.chat.phone || "");
  const headers = (from: Headers) => {
    const h = new Headers({ "Content-Type": m.mediaMime!, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
    for (const k of ["content-length", "content-range", "accept-ranges"]) if (from.get(k)) h.set(k, from.get(k)!);
    h.set("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    return h;
  };

  const range = request.headers.get("range");
  const res = await fetchSupportMedia(m.chat.number, m.externalId, range).catch(() => null);
  if (res?.ok && res.body) return new Response(res.body, { status: res.status, headers: headers(res.headers) });

  // The server does not have it (or is down): the Drive copy
  const drive = m.driveFileId ? await supportDrive() : null;
  if (drive && m.driveFileId) {
    const token = await accessTokenFrom(drive.token);
    const copy = await fetch(`https://www.googleapis.com/drive/v3/files/${m.driveFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, ...(range && { Range: range }) },
    });
    if (copy.ok && copy.body) return new Response(copy.body, { status: copy.status, headers: headers(copy.headers) });
  }
  const why = m.mediaStatus === "baixando" ? "O arquivo ainda está sendo baixado do WhatsApp." : "O arquivo não está disponível.";
  return Response.json({ error: why }, { status: 404 });
}
