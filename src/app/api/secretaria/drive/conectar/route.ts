import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { GOOGLE_STATE_COOKIE, googleAuthUrl, googleConfigured, googleRedirectUri } from "@/lib/google";
import { SECRETARY_DRIVE_SCOPES } from "@/lib/secretary-drive";

/** "Conectar o Google Drive" (tela Secretária): the owner lets the secretary read the reports folder. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (user.role !== "OWNER") return NextResponse.redirect(new URL("/", request.url));
  if (!googleConfigured()) return NextResponse.redirect(new URL("/secretaria?drive=erro&detalhe=Faltam%20as%20chaves%20do%20Google#drive", request.url));
  const state = `${user.id}.jdrive.${randomBytes(16).toString("hex")}`;
  const res = NextResponse.redirect(googleAuthUrl(state, googleRedirectUri(request.url), SECRETARY_DRIVE_SCOPES));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/api/google",
  });
  return res;
}
