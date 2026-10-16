import { getVercelOidcToken } from "@vercel/oidc";

// ---------- WebM (Chrome's recording) to Ogg (what WhatsApp plays as a voice message) ----------
// Both carry the same Opus audio: only the box around it changes, so nothing is re-encoded.

const EBML_MASTERS = new Set([0x18538067, 0x1f43b675, 0x1654ae6b, 0xae, 0xa0]); // Segment, Cluster, Tracks, TrackEntry, BlockGroup
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const SIMPLE_BLOCK = 0xa3;
const BLOCK = 0xa1;

function vint(buf: Uint8Array, pos: number, keepMarker: boolean) {
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new Error("WebM inválido.");
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** The Opus packets and the OpusHead of a WebM audio recording. */
export function readWebmOpus(buf: Uint8Array) {
  const packets: Uint8Array[] = [];
  let head: Uint8Array | null = null;
  let codec = "";
  let pos = 0;
  while (pos < buf.length) {
    const id = vint(buf, pos, true);
    const size = vint(buf, pos + id.length, false);
    const start = pos + id.length + size.length;
    if (EBML_MASTERS.has(id.value)) {
      // Children follow right away; a recording still being written has no size here
      pos = start;
      continue;
    }
    if (size.unknown) throw new Error("WebM inválido.");
    const end = Math.min(start + size.value, buf.length);
    if (id.value === CODEC_ID) codec = new TextDecoder().decode(buf.subarray(start, end));
    else if (id.value === CODEC_PRIVATE) head = buf.slice(start, end);
    else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      const track = vint(buf, start, false);
      const flags = buf[start + track.length + 2];
      if (flags & 0x06) throw new Error("WebM com lacing não é suportado.");
      packets.push(buf.slice(start + track.length + 3, end));
    }
    pos = end;
  }
  if (codec && codec !== "A_OPUS") throw new Error(`Áudio ${codec} não suportado: grave de novo.`);
  if (!packets.length) throw new Error("A gravação está vazia.");
  return { head: head ?? opusHead(1, 312), packets };
}

function opusHead(channels: number, preSkip: number) {
  const h = new Uint8Array(19);
  h.set(new TextEncoder().encode("OpusHead"));
  const v = new DataView(h.buffer);
  v.setUint8(8, 1);
  v.setUint8(9, channels);
  v.setUint16(10, preSkip, true);
  v.setUint32(12, 48000, true);
  return h;
}

/** How many 48 kHz samples one Opus packet holds, from its first byte (RFC 6716, 3.1). */
export function opusSamples(packet: Uint8Array) {
  const config = packet[0] >> 3;
  const ms = config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
  const code = packet[0] & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  return frames * ms * 48;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(page: Uint8Array) {
  let crc = 0;
  for (const b of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

function oggPage(packets: Uint8Array[], granule: number, seq: number, type: number) {
  const lacing: number[] = [];
  for (const p of packets) {
    for (let n = p.length; ; n -= 255) {
      lacing.push(Math.min(n, 255));
      if (n < 255) break;
    }
  }
  const bodyLength = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const v = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"));
  v.setUint8(5, type);
  v.setBigInt64(6, BigInt(granule), true);
  v.setUint32(14, 0x42414e4e, true); // stream serial: "BANN"
  v.setUint32(18, seq, true);
  v.setUint8(26, lacing.length);
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    page.set(p, at);
    at += p.length;
  }
  v.setUint32(22, oggCrc(page), true);
  return page;
}

/** Ogg Opus file (RFC 7845) from the packets of a WebM recording. */
export function webmToOgg(webm: Uint8Array) {
  const { head, packets } = readWebmOpus(webm);
  const vendor = new TextEncoder().encode("CRM Banneg");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages = [oggPage([head], 0, 0, 0x02), oggPage([tags], 0, 1, 0)];
  let granule = 0;
  let batch: Uint8Array[] = [];
  let segments = 0;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    batch.push(p);
    segments += Math.floor(p.length / 255) + 1;
    granule += opusSamples(p);
    const last = i === packets.length - 1;
    // About one second of audio per page, never over Ogg's 255 segments
    if (last || segments > 200 || batch.length >= 50) {
      pages.push(oggPage(batch, granule, pages.length, last ? 0x04 : 0));
      batch = [];
      segments = 0;
    }
  }
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** "audio/ogg; codecs=opus" -> "audio/ogg"; WhatsApp takes ogg (Opus), mp4, mpeg, aac and amr audio. */
export function baseMime(type: string) {
  return type.split(";")[0].trim().toLowerCase();
}

export const WHATSAPP_AUDIO = new Set(["audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/amr"]);

// ---------- Transcription ----------

// Starts the body of audio messages, so the AI, the funnel cards and the conversation list show it was spoken
export const AUDIO_MARK = "🎤";

const GATEWAY = "https://ai-gateway.vercel.sh/v4/ai/transcription-model";

/**
 * Speech to text through Vercel's AI Gateway: on Vercel it signs in with the project's own token,
 * so no extra key is needed. AI_GATEWAY_API_KEY works too (outside Vercel or to use another account).
 */
export async function transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
  const token = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken().catch(() => ""));
  if (!token) throw new Error("Transcrição indisponível: o servidor não tem acesso ao AI Gateway da Vercel.");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "ai-gateway-protocol-version": "0.0.1",
      "ai-transcription-model-specification-version": "4",
      "ai-model-id": process.env.TRANSCRIBE_MODEL || "openai/whisper-1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audio: Buffer.from(audio).toString("base64"), mediaType: baseMime(mimeType) }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } | string };
  if (!res.ok) {
    const message = typeof json.error === "string" ? json.error : json.error?.message;
    throw new Error(`Transcrição falhou: ${message ?? `HTTP ${res.status}`}`);
  }
  return (json.text ?? "").trim();
}

// ---------- WhatsApp media ----------

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;

/** The file of a message the lead sent: Meta gives a short-lived link that needs the token. */
export async function downloadWhatsAppMedia(mediaId: string) {
  const headers = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const info = await fetch(`${GRAPH}/${mediaId}`, { headers });
  const meta = (await info.json().catch(() => ({}))) as { url?: string; mime_type?: string; error?: { message?: string } };
  if (!info.ok || !meta.url) throw new Error(`Não consegui baixar o áudio da Meta: ${meta.error?.message ?? `HTTP ${info.status}`}`);
  const file = await fetch(meta.url, { headers });
  if (!file.ok) throw new Error(`Não consegui baixar o áudio da Meta: HTTP ${file.status}`);
  return { data: new Uint8Array(await file.arrayBuffer()), mimeType: baseMime(meta.mime_type ?? file.headers.get("content-type") ?? "audio/ogg") };
}

/** Puts a file at Meta and returns its id, to send it without a public link. */
export async function uploadWhatsAppMedia(data: Uint8Array, mimeType: string, filename: string) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), filename);
  const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(`A Meta não aceitou o áudio: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json.id;
}
