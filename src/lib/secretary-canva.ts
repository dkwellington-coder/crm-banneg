import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";

/**
 * Jessica's Canva (Wellington, 2026-11-26: "vamos fazer um teste com o Canva, o CRM já faz essa ponte"). The CRM talks
 * to Canva's own MCP server (mcp.canva.com) with his Canva login, given once on the Secretária screen. His account has no
 * Canva AI credits, so she does not generate designs from scratch: she copies one of HIS models from the Canva folder
 * "Modelos Jessica", swaps its texts, exports a PNG and sends it on WhatsApp. She only ever touches that folder.
 */
export const CANVA_MCP = "https://mcp.canva.com";
const ENDPOINT = `${CANVA_MCP}/mcp`;
const KEY = "secretaria_canva";
export const CANVA_FOLDER = "Modelos Jessica";
const SCOPES = ["profile:read", "design:meta:read", "design:content:read", "design:content:write", "folder:read", "asset:read"];

export type SecretaryCanva = {
  clientId: string;
  redirectUri: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null; // ms
  connectedAt?: string | null;
  pending?: { state: string; verifier: string } | null;
};

export async function secretaryCanva() {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return row ? (row.value as SecretaryCanva) : null;
}

async function save(v: SecretaryCanva) {
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: v }, update: { value: v } });
}

export async function disconnectSecretaryCanva() {
  await db.setting.deleteMany({ where: { key: KEY } });
}

export const canvaConnected = (c: SecretaryCanva | null) => !!c?.refreshToken;

const b64url = (b: Buffer) => b.toString("base64url");

async function post(url: string, body: Record<string, string> | object, form = false) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", Accept: "application/json" },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Canva respondeu ${res.status}: ${String(json.error_description ?? json.error ?? "erro")}`);
  return json;
}

/** Step 1 of "Conectar o Canva": registers the CRM with Canva (once per address) and gives the login link. */
export async function startCanvaConnect(redirectUri: string, userId: string) {
  let c = await secretaryCanva();
  if (!c || c.redirectUri !== redirectUri) {
    const reg = await post(`${CANVA_MCP}/register`, {
      client_name: "CRM Banneg",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    c = { clientId: String(reg.client_id), redirectUri };
  }
  const verifier = b64url(randomBytes(32));
  const state = `${userId}.${b64url(randomBytes(16))}`;
  await save({ ...c, pending: { state, verifier } });
  const url = new URL(`${CANVA_MCP}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: redirectUri,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    scope: SCOPES.join(" "),
    resource: ENDPOINT,
  }).toString();
  return url.toString();
}

function tokens(c: SecretaryCanva, t: Record<string, unknown>): SecretaryCanva {
  return {
    ...c,
    accessToken: String(t.access_token),
    refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : c.refreshToken,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    pending: null,
  };
}

/** Step 2: Canva sent him back with a code. */
export async function finishCanvaConnect(code: string, state: string, userId: string) {
  const c = await secretaryCanva();
  if (!c?.pending || c.pending.state !== state || !state.startsWith(`${userId}.`)) throw new Error("A conexão expirou. Clique em conectar de novo.");
  const t = await post(
    `${CANVA_MCP}/token`,
    { grant_type: "authorization_code", code, redirect_uri: c.redirectUri, client_id: c.clientId, code_verifier: c.pending.verifier, resource: ENDPOINT },
    true,
  );
  await save({ ...tokens(c, t), connectedAt: new Date().toISOString() });
}

async function accessToken() {
  const c = await secretaryCanva();
  if (!canvaConnected(c)) throw new Error("O Canva da secretária não está conectado (tela Secretária > Canva).");
  if (c!.accessToken && (c!.expiresAt ?? 0) > Date.now() + 60_000) return c!.accessToken;
  const t = await post(`${CANVA_MCP}/token`, { grant_type: "refresh_token", refresh_token: c!.refreshToken!, client_id: c!.clientId, resource: ENDPOINT }, true).catch((e: Error) => {
    throw new Error(`O Canva pediu login de novo (tela Secretária > Canva). ${e.message}`);
  });
  const next = tokens(c!, t);
  await save(next);
  return next.accessToken!;
}

// ---------- MCP over HTTP (JSON-RPC; the answer comes as JSON or as an event stream) ----------

type Rpc = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };

/** The JSON-RPC answer with this id, from a JSON body or from the "data:" lines of an event stream. */
export function rpcAnswer(body: string, contentType: string, id: number): Rpc | null {
  const all: Rpc[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          const v = JSON.parse(data);
          all.push(...(Array.isArray(v) ? v : [v]));
        } catch {
          /* keep-alive or partial line */
        }
      }
    }
  } else if (body.trim()) {
    const v = JSON.parse(body);
    all.push(...(Array.isArray(v) ? v : [v]));
  }
  return all.find((m) => m.id === id) ?? null;
}

class Session {
  private id: string | null = null;
  private seq = 0;
  constructor(private token: string) {}

  private async send(method: string, params: object, notify = false) {
    const id = notify ? undefined : ++this.seq;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(this.id && { "Mcp-Session-Id": this.id }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id !== undefined && { id }) }),
      signal: AbortSignal.timeout(90_000),
    });
    this.id = res.headers.get("mcp-session-id") ?? this.id;
    const body = await res.text();
    if (res.status === 401) throw new Error("O Canva pediu login de novo (tela Secretária > Canva).");
    if (!res.ok) throw new Error(`Canva respondeu ${res.status}: ${body.slice(0, 200)}`);
    if (id === undefined) return null;
    const answer = rpcAnswer(body, res.headers.get("content-type") ?? "", id);
    if (!answer) throw new Error("O Canva não respondeu.");
    if (answer.error) throw new Error(`Canva: ${answer.error.message ?? "erro"}`);
    return answer.result ?? {};
  }

  async open() {
    await this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crm-banneg", version: "1" } });
    await this.send("notifications/initialized", {}, true);
    return this;
  }

  /** A Canva tool's answer, as the JSON it writes in its text (or its structured content). */
  async tool<T = Record<string, unknown>>(name: string, args: object): Promise<T> {
    const r = (await this.send("tools/call", { name, arguments: { ...args, user_intent: "Secretária do CRM Banneg faz uma arte a partir de um modelo do Wellington" } }))!;
    const parts = (r.content as { type: string; text?: string }[] | undefined) ?? [];
    const textOut = parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!).join("\n");
    if (r.isError) throw new Error(`Canva (${name}): ${textOut.slice(0, 300) || "erro"}`);
    if (r.structuredContent) return r.structuredContent as T;
    try {
      return JSON.parse(textOut) as T;
    } catch {
      return { text: textOut } as T;
    }
  }
}

async function session() {
  return new Session(await accessToken()).open();
}

// ---------- The models in "Modelos Jessica" ----------

type Obj = Record<string, unknown>;
const arr = (v: unknown) => (Array.isArray(v) ? (v as Obj[]) : []);
const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** A design or folder out of Canva's list answers, whichever shape they come in ({id,title} or {type, design:{...}}). */
function entries(v: Obj, kind: "design" | "folder") {
  const items = arr(v.items ?? v.folders ?? v.designs ?? v.results);
  return items
    .map((it) => (it[kind] as Obj | undefined) ?? (it.type && it.type !== kind ? null : it))
    .filter((x): x is Obj => !!x && typeof x.id === "string")
    .map((x) => ({ id: String(x.id), name: String(x.title ?? x.name ?? "") }));
}

export type CanvaText = { locator: string; page: number; text: string };

/** The text boxes of a design (page by page), from read-design's design_content. */
export function textsOf(content: unknown): CanvaText[] {
  const out: CanvaText[] = [];
  const pages = arr((content as Obj | null)?.pages);
  pages.forEach((p, i) => {
    const walk = (els: Obj[]) => {
      for (const el of els) {
        const regions = arr(el.textRegions);
        const t = regions.map((r) => String(r.characters ?? "")).join("");
        if (el.type === "text" && t.trim() && typeof el.locator_id === "string") out.push({ locator: el.locator_id, page: i + 1, text: t });
        walk(arr(el.elements ?? el.children));
      }
    };
    walk(arr(p.elements));
  });
  return out;
}

/** Which text box each swap is about: the box whose text is the one given, else the one that contains it. */
export function matchSwaps(texts: CanvaText[], swaps: { de: string; para: string }[]) {
  const used = new Set<string>();
  const plan: { locator: string; page: number; text: string }[] = [];
  const missing: string[] = [];
  for (const sw of swaps) {
    const want = plain(sw.de);
    if (!want) continue;
    const box =
      texts.find((t) => !used.has(t.locator) && plain(t.text) === want) ?? texts.find((t) => !used.has(t.locator) && plain(t.text).includes(want));
    if (!box) {
      missing.push(sw.de);
      continue;
    }
    used.add(box.locator);
    plan.push({ locator: box.locator, page: box.page, text: sw.para });
  }
  return { plan, missing };
}

async function modelFolder(s: Session) {
  const found = await s.tool<Obj>("search-folders", { query: CANVA_FOLDER, ownership: "any", limit: 10 });
  const folder = entries(found, "folder").find((f) => plain(f.name) === plain(CANVA_FOLDER));
  if (!folder) throw new Error(`Não achei a pasta "${CANVA_FOLDER}" no Canva do Wellington: ele precisa criá-la e colocar os modelos lá.`);
  return folder.id;
}

async function modelList(s: Session) {
  const folderId = await modelFolder(s);
  const listed = await s.tool<Obj>("list-folder-items", { folder_id: folderId, item_types: ["design"], sort_by: "title_ascending" });
  return entries(listed, "design");
}

async function readTexts(s: Session, designId: string) {
  const r = await s.tool<Obj>("read-design", { design_id: designId, open_transaction: true, filter: { fields: ["design_content"] } });
  const tx = String((r.transaction as Obj | undefined)?.transaction_id ?? "");
  return { tx, texts: textsOf(r.design_content) };
}

/** The models she may use, with the texts on each, so she knows what to swap. */
export async function canvaModels() {
  const s = await session();
  const models = await modelList(s);
  if (!models.length) throw new Error(`A pasta "${CANVA_FOLDER}" no Canva está vazia.`);
  const out: { id: string; nome: string; textos: string[] }[] = [];
  for (const m of models.slice(0, 12)) {
    const { tx, texts } = await readTexts(s, m.id);
    if (tx) await s.tool("edit-design", { transaction_id: tx, finalize: "cancel" }).catch(() => null);
    out.push({ id: m.id, nome: m.name, textos: texts.map((t) => t.text) });
  }
  return out;
}

async function download(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Não consegui baixar a arte do Canva (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The art: a copy of the model (his original stays as it is) with the texts swapped, exported as PNG.
 * Only a model inside "Modelos Jessica" can be used, never any other design of his Canva.
 */
export async function canvaArt(modelId: string, swaps: { de: string; para: string }[], title: string) {
  const s = await session();
  const models = await modelList(s);
  const model = models.find((m) => m.id === modelId.trim());
  if (!model) throw new Error(`Esse modelo não está na pasta "${CANVA_FOLDER}". Use canva_modelos para ver os modelos.`);
  const copy = await s.tool<Obj>("copy-design", { design_id: model.id });
  const design = (copy.design as Obj | undefined) ?? copy;
  const id = String(design.id ?? "");
  if (!/^D[\w-]{10}$/.test(id)) throw new Error("O Canva não devolveu a cópia do modelo.");
  const { tx, texts } = await readTexts(s, id);
  if (!tx) throw new Error("O Canva não abriu a cópia para editar.");
  const { plan, missing } = matchSwaps(texts, swaps);
  if (!plan.length) {
    await s.tool("edit-design", { transaction_id: tx, finalize: "cancel" }).catch(() => null);
    throw new Error(`Nenhum texto trocado: não achei ${missing.map((m) => `"${m}"`).join(", ")} no modelo. Textos dele: ${texts.map((t) => `"${t.text}"`).join(", ")}`);
  }
  const pages = [...new Set(plan.map((p) => p.page))];
  for (const page of pages) {
    const operations: Obj[] = plan.filter((p) => p.page === page).map((p) => ({ type: "replace_text", locator_id: p.locator, text: p.text }));
    if (page === pages[0]) operations.unshift({ type: "update_title", title: `Jessica · ${title || model.name}`.slice(0, 120) });
    await s.tool("edit-design", { transaction_id: tx, page_index: page, operations, finalize: "keep_open" });
  }
  await s.tool("edit-design", { transaction_id: tx, finalize: "commit" });
  const exported = await s.tool<Obj>("export-design", { design_id: id, format: { type: "png", width: 1080 } });
  const job = (exported.job as Obj | undefined) ?? exported;
  const urls = Array.isArray(job.urls) ? (job.urls as unknown[]).filter((u): u is string => typeof u === "string") : [];
  if (!urls.length) throw new Error(`O Canva não terminou de exportar a arte (${String(job.status ?? "sem status")}).`);
  const pngs = [];
  for (const u of urls.slice(0, 5)) pngs.push(await download(u));
  const editUrl = String(((design.urls as Obj | undefined)?.edit_url as string | undefined) ?? "");
  return { pngs, designId: id, editUrl, model: model.name, missing };
}
