import { currentUser } from "@/lib/auth";
import { canSee } from "@/lib/areas";
import { artFromForm } from "@/lib/art-form";
import { loadArtAssets, photoDataUrl, renderArt } from "@/lib/secretary-art";

/** The Artes screen draws the art here and gets a PNG back (Wellington, 2026-11-27). */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM." }, { status: 401 });
  if (!canSee(user, "artes")) return Response.json({ error: "Sem acesso a esta tela." }, { status: 403 });
  try {
    const form = await request.formData();
    const fields: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
    const assets = await loadArtAssets();
    const foto = form.get("foto");
    if (foto && typeof foto !== "string" && foto.size > 0) {
      assets.photo = photoDataUrl(Buffer.from(await foto.arrayBuffer()), foto.type);
    } else if (fields.foto_material) {
      const res = await fetch(new URL(`/materiais/${fields.foto_material.replace(/[^\w.-]/g, "")}`, request.url));
      if (res.ok) assets.photo = photoDataUrl(Buffer.from(await res.arrayBuffer()), res.headers.get("content-type") ?? "image/jpeg");
    }
    const png = await renderArt(artFromForm(fields), assets);
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
