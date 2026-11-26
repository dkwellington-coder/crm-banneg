import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { finishCanvaConnect } from "@/lib/secretary-canva";

/** Canva sends him back here after the login. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const url = new URL(request.url);
  const to = (result: string, detail?: string) =>
    NextResponse.redirect(new URL(`/secretaria?canva=${result}${detail ? `&detalhe=${encodeURIComponent(detail)}` : ""}#canva`, request.url));
  if (user.role !== "OWNER") return to("erro", "Só o proprietário liga o Canva da secretária.");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state) return to("recusado");
  try {
    await finishCanvaConnect(code, state, user.id);
    return to("ok");
  } catch (e) {
    return to("erro", (e as Error).message);
  }
}
