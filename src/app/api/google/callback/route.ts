import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUser } from "@/lib/auth";
import { GOOGLE_STATE_COOKIE, connectGoogle, googleRedirectUri } from "@/lib/google";

/** Google sends the person back here after they allow (or refuse) the CRM on their agenda. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (result: string, detail?: string) => {
    const res = NextResponse.redirect(new URL(`/integracoes?google=${result}${detail ? `&detalhe=${encodeURIComponent(detail)}` : ""}#google`, request.url));
    res.cookies.set(GOOGLE_STATE_COOKIE, "", { path: "/api/google", maxAge: 0 });
    return res;
  };
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (url.searchParams.get("error")) return back("recusado");
  const expected = (await cookies()).get(GOOGLE_STATE_COOKIE)?.value;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== expected || !state.startsWith(`${user.id}.`)) return back("erro", "A conexão expirou. Clique em conectar de novo.");
  try {
    const link = await connectGoogle(user.id, code, googleRedirectUri(request.url));
    return back("ok", link.email);
  } catch (e) {
    return back("erro", (e as Error).message);
  }
}
