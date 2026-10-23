import { connectionKey, FormError, readLandingForm, takeLandingLead } from "@/lib/landing-form";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

// The landing page's franchise form posts here, from the form page the CRM itself serves (/form/franquia).
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) throw new FormError("Origem não autorizada.", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new FormError("Formato inválido.", 415);
    const raw = await request.text();
    if (raw.length > 16_000) throw new FormError("Conteúdo muito grande.", 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new FormError("Formato inválido.");
    }
    const form = readLandingForm(body);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "?";
    const r = await takeLandingLead(form, connectionKey(ip));
    return json({ saved: true, receipt: form.eventId }, r.created ? 201 : 200);
  } catch (e) {
    if (e instanceof FormError) return json({ error: e.message }, e.status);
    console.error("Formulário da landing:", (e as Error).message);
    return json({ error: "Não foi possível confirmar o cadastro. Seus dados continuam no formulário. Tente novamente." }, 503);
  }
}
