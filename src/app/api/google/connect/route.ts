import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { GOOGLE_STATE_COOKIE, googleAuthUrl, googleConfigured, googleRedirectUri } from "@/lib/google";

/** "Conectar minha Agenda Google": sends the person to Google to allow the CRM on their agenda. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (!googleConfigured()) return NextResponse.redirect(new URL("/integracoes?google=sem-chaves#google", request.url));
  // Ties Google's answer to this browser and this user, so nobody can attach their agenda to someone else's login
  const state = `${user.id}.${randomBytes(16).toString("hex")}`;
  const res = NextResponse.redirect(googleAuthUrl(state, googleRedirectUri(request.url)));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/api/google",
  });
  return res;
}
