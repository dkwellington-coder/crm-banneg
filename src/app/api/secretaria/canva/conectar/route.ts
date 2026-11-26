import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { startCanvaConnect } from "@/lib/secretary-canva";

/** "Conectar o Canva" (tela Secretária): the owner logs in to Canva once so Jessica can use his models. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (user.role !== "OWNER") return NextResponse.redirect(new URL("/", request.url));
  try {
    const redirectUri = new URL("/api/secretaria/canva/callback", request.url).toString();
    return NextResponse.redirect(await startCanvaConnect(redirectUri, user.id));
  } catch (e) {
    return NextResponse.redirect(new URL(`/secretaria?canva=erro&detalhe=${encodeURIComponent((e as Error).message)}#canva`, request.url));
  }
}
