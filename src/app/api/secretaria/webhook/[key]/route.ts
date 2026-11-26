import { after } from "next/server";
import { receiveSecretary, TURN_DEBOUNCE_MS } from "@/lib/secretary";
import { runDueJobs } from "@/lib/jobs";

// Her answer runs right after the post (the reader waits a few seconds, not the next minute of the scheduler)
export const maxDuration = 300;

/** The WhatsApp server posts here what reaches the secretary's number: her group and her private chats. */
export async function POST(request: Request, ctx: RouteContext<"/api/secretaria/webhook/[key]">) {
  const { key } = await ctx.params;
  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: "corpo inválido" }, { status: 400 });
  let queued = false;
  for (const p of Array.isArray(payload) ? payload : [payload]) {
    try {
      const result = await receiveSecretary(key, p);
      if (!result.ok) return Response.json({ error: result.reason }, { status: result.status });
      if ("queued" in result || !("ignored" in result)) queued = true;
    } catch (e) {
      console.error("Secretária: mensagem não gravada", (e as Error).message);
      return Response.json({ error: "não gravada" }, { status: 500 });
    }
  }
  if (queued)
    after(async () => {
      // A burst of messages pushes her turn ahead: whoever posts last finds it due
      await new Promise((r) => setTimeout(r, TURN_DEBOUNCE_MS + 1_500));
      await runDueJobs(5, "secretaria.turn").catch((e: Error) => console.error("Secretária: turno falhou", e.message));
    });
  return Response.json({ ok: true });
}
