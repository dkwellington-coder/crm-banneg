import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db } from "./db";

// Create and see events (with Meet) and read when the calendar is busy; openid/email say which account connected
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

// Ties Google's answer to the browser and the user that asked to connect
export const GOOGLE_STATE_COOKIE = "google_oauth_state";

export type GoogleLink = { email: string; connectedAt: string; token: string };

const settingKey = (userId: string) => `google:${userId}`;

export function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Where Google sends the person back after they allow the CRM; must be registered in the Google Cloud client. */
export function googleRedirectUri(requestUrl: string) {
  return new URL("/api/google/callback", process.env.APP_URL || requestUrl).toString();
}

export function googleAuthUrl(state: string, redirectUri: string) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // offline + consent: Google hands a refresh token, so the CRM keeps booking without anyone logged in
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// The refresh token is stored encrypted: a copy of the database alone does not open anyone's agenda
function cipherKey() {
  return createHash("sha256").update(`crm-banneg:google:${process.env.GOOGLE_CLIENT_SECRET ?? ""}`).digest();
}

export function sealToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function openToken(sealed: string) {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", cipherKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok) throw new Error(`Google recusou (${json.error_description ?? json.error ?? `HTTP ${res.status}`}).`);
  return json;
}

/** Trades the code Google sent back for a refresh token and saves it for this user. */
export async function connectGoogle(userId: string, code: string, redirectUri: string) {
  const json = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!json.refresh_token) throw new Error("O Google não mandou a permissão permanente. Tente conectar de novo.");
  // The id_token came straight from Google over HTTPS, so its payload can be read as is
  const payload = json.id_token ? JSON.parse(Buffer.from(json.id_token.split(".")[1], "base64url").toString("utf8")) : {};
  const link: GoogleLink = { email: String(payload.email ?? ""), connectedAt: new Date().toISOString(), token: sealToken(json.refresh_token) };
  await db.setting.upsert({ where: { key: settingKey(userId) }, create: { key: settingKey(userId), value: link }, update: { value: link } });
  // The scheduler proves the new connection on its next round
  await db.setting.deleteMany({ where: { key: "calendar_check" } });
  return link;
}

export async function disconnectGoogle(userId: string) {
  const link = await googleLinkOf(userId);
  if (!link) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(openToken(link.token))}`, { method: "POST" });
  } catch {
    // Revoking is a courtesy: without the token stored, the CRM no longer reaches the agenda anyway
  }
  await db.setting.deleteMany({ where: { key: settingKey(userId) } });
}

export async function googleLinkOf(userId: string) {
  const row = await db.setting.findUnique({ where: { key: settingKey(userId) } });
  return row ? (row.value as GoogleLink) : null;
}

/** Everyone who connected their Google, the owner first. */
export async function googleLinks() {
  const rows = await db.setting.findMany({ where: { key: { startsWith: "google:" } } });
  const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.key.slice("google:".length)) } } });
  return rows
    .map((r) => ({ user: users.find((u) => `google:${u.id}` === r.key), link: r.value as GoogleLink }))
    .filter((x): x is { user: NonNullable<typeof x.user>; link: GoogleLink } => !!x.user)
    .sort((a, b) => (a.user.role === "OWNER" ? -1 : b.user.role === "OWNER" ? 1 : 0));
}

export async function accessTokenFrom(sealed: string) {
  const json = await tokenRequest({ refresh_token: openToken(sealed), grant_type: "refresh_token" });
  return json.access_token!;
}

/**
 * Which Google agenda books a meeting for this manager:
 * - their own, when they connected it;
 * - else the agenda of someone who connected (the owner first), with the manager invited to the event;
 * - else the older single key in Vercel (GOOGLE_REFRESH_TOKEN), on the manager's calendar.
 */
export async function googleAgendaFor(user: { id: string; email: string; calendarId: string | null }) {
  if (!googleConfigured()) return null;
  const own = await googleLinkOf(user.id);
  if (own) return { accessToken: await accessTokenFrom(own.token), calendarId: "primary", account: own.email, invite: null as string | null };
  const other = (await googleLinks())[0];
  if (other) return { accessToken: await accessTokenFrom(other.link.token), calendarId: "primary", account: other.link.email, invite: user.email };
  const legacy = process.env.GOOGLE_REFRESH_TOKEN;
  if (legacy) {
    const json = await tokenRequest({ refresh_token: legacy, grant_type: "refresh_token" });
    return { accessToken: json.access_token!, calendarId: user.calendarId ?? user.email, account: user.calendarId ?? user.email, invite: null };
  }
  return null;
}
