import { FORM_CSP, landingFormPage } from "@/lib/landing-form";

// The landing page's franchise form, shown in an iframe on franquia.banneg.com.br. "principal" is the name the page
// already used on the old capture service, so only the address changes there.
export async function GET(_request: Request, { params }: { params: Promise<{ form: string }> }) {
  const { form } = await params;
  if (form !== "franquia" && form !== "principal") return new Response("Formulário não encontrado.", { status: 404 });
  return new Response(landingFormPage("/api/form/franquia"), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": FORM_CSP,
    },
  });
}
