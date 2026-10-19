import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { appendDocumentChunk, finishDocument, MAX_DOCUMENT_BYTES } from "@/lib/cof";

const TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "application/zip",
]);

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Upload of the COF, balance sheets and contract, in three steps: start (name and type), the pieces of
 * the file, and finish (size and fingerprint are computed and the file starts going with the COF).
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return json({ error: "Entre no CRM." }, 401);
  if (user.role === "SELLER") return json({ error: "Apenas gestores podem enviar os documentos da franquia." }, 403);
  const url = new URL(request.url);
  const step = url.searchParams.get("step");
  const id = url.searchParams.get("id") ?? "";

  if (step === "start") {
    const { name, mimeType, size } = (await request.json()) as { name?: string; mimeType?: string; size?: number };
    if (!name || !size) return json({ error: "Arquivo sem nome ou vazio." }, 400);
    if (size > MAX_DOCUMENT_BYTES) return json({ error: "Arquivo maior que 40 MB." }, 400);
    const type = mimeType && TYPES.has(mimeType) ? mimeType : "application/octet-stream";
    const doc = await db.franchiseDocument.create({
      data: { name: name.slice(0, 200), mimeType: type, size, data: new Uint8Array(0), uploadedBy: user.name },
      select: { id: true },
    });
    return json(doc);
  }

  const doc = await db.franchiseDocument.findUnique({ where: { id }, select: { id: true, name: true, active: true, sha256: true } });
  if (!doc || doc.sha256) return json({ error: "Envio não encontrado ou já concluído." }, 404);

  if (step === "chunk") {
    const chunk = new Uint8Array(await request.arrayBuffer());
    if (!chunk.length) return json({ error: "Parte vazia." }, 400);
    if (!(await appendDocumentChunk(id, chunk))) return json({ error: "Arquivo maior que 40 MB." }, 400);
    return json({ ok: true });
  }

  if (step === "finish") {
    const done = await finishDocument(id);
    if (!done) return json({ error: "Envio não encontrado." }, 404);
    return json(done);
  }

  return json({ error: "Passo inválido." }, 400);
}
