import { after } from "next/server";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { handleInbound } from "@/lib/leads";
import { afterUndelivered } from "@/lib/messaging";
import { classifyError, clearHealth, messageText, problemNumber, setHealth, verifySignature, type WebhookPayload } from "@/lib/whatsapp";
import { forwardCopy } from "@/lib/whatsapp-forward";

// Meta calls this once to confirm the webhook URL
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ok =
    url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    return new Response("invalid signature", { status: 401 });
  }
  // The old CRM keeps getting every message too (Wellington's choice while both are in use)
  after(() => forwardCopy(raw, request.headers));
  const payload = JSON.parse(raw) as WebhookPayload;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const profileName = value.contacts?.[0]?.profile?.name;
      for (const m of value.messages ?? []) {
        await handleInbound({
          phone: m.from,
          profileName,
          body: messageText(m),
          externalId: m.id,
          at: new Date(Number(m.timestamp) * 1000),
          audio: m.audio && { id: m.audio.id, mimeType: m.audio.mime_type?.split(";")[0] },
          phoneNumberId: value.metadata?.phone_number_id,
        });
      }
      for (const st of value.statuses ?? []) {
        const msg = await db.message.findUnique({ where: { externalId: st.id } });
        if (!msg) continue;
        if (st.status === "failed") {
          const err = st.errors?.[0];
          const { accountLevel, friendly } = classifyError(err?.code, err?.message ?? err?.title ?? "Falha no envio");
          if (accountLevel) await setHealth({ code: err?.code, message: friendly }, problemNumber(err?.code, value.metadata?.phone_number_id));
          await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: friendly, errorCode: err?.code } });
          await logEvent(msg.leadId, "whatsapp.failed", "WhatsApp", `Mensagem não entregue: ${friendly}`, { code: err?.code ?? null });
          await afterUndelivered(msg.leadId, friendly, err?.code);
        } else {
          const status = st.status === "read" ? "READ" : st.status === "delivered" ? "DELIVERED" : "SENT";
          await db.message.update({ where: { id: msg.id }, data: { status } });
          // A delivered message proves the number it went from (and, for the main one, the account) is healthy again
          await clearHealth(value.metadata?.phone_number_id);
        }
      }
    }
  }
  return Response.json({ ok: true });
}
