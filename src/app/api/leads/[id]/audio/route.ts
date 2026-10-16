import { after } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { sendAudioMessage, transcribeSentAudio } from "@/lib/messaging";

// WhatsApp takes audio up to 16 MB; a 5-minute recording in the CRM is well under 2 MB
const MAX_BYTES = 4 * 1024 * 1024;

/** An audio recorded on the lead's page goes to the lead on WhatsApp. */
export async function POST(request: Request, ctx: RouteContext<"/api/leads/[id]/audio">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  const { id } = await ctx.params;
  const lead = await db.lead.findUnique({ where: { id } });
  if (!lead) return Response.json({ error: "Lead não encontrado." }, { status: 404 });
  const file = (await request.formData()).get("audio");
  if (!(file instanceof Blob) || file.size === 0) return Response.json({ error: "Nenhum áudio gravado." }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "Áudio longo demais: grave até 5 minutos." }, { status: 413 });
  try {
    const res = await sendAudioMessage(lead, new Uint8Array(await file.arrayBuffer()), file.type, user.name);
    if (!res.ok) return Response.json({ error: res.error }, { status: 502 });
    if ("messageId" in res) after(() => transcribeSentAudio(res.messageId));
    if (!lead.aiPaused) {
      // A person answered: the AI steps back so the two never talk over each other
      await db.lead.update({ where: { id }, data: { aiPaused: true } });
      await logEvent(id, "ai.paused", user.name, "IA pausada: atendimento humano assumiu.");
    }
    return Response.json({ ok: true, simulated: "simulated" in res && res.simulated });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
