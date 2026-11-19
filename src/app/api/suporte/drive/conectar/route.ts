import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { GOOGLE_STATE_COOKIE, googleAuthUrl, googleConfigured, googleRedirectUri } from "@/lib/google";
import { DRIVE_SCOPES } from "@/lib/support-drive";

/** "Conectar o Google Drive" (Suporte > Números e atendentes): the owner allows the CRM to save the support files. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (user.role !== "OWNER") return NextResponse.redirect(new URL("/suporte", request.url));
  if (!googleConfigured()) return NextResponse.redirect(new URL("/suporte/numeros?drive=erro&detalhe=Faltam%20as%20chaves%20do%20Google#drive", request.url));
  const state = `${user.id}.drive.${randomBytes(16).toString("hex")}`;
  const res = NextResponse.redirect(googleAuthUrl(state, googleRedirectUri(request.url), DRIVE_SCOPES));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/api/google",
  });
  return res;
}
