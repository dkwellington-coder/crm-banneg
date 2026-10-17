// Voice notes: the WebM a browser records becomes the Ogg WhatsApp plays, and audio goes in and out
// of a conversation with its transcript. The DB part runs only when TEST_DATABASE_URL is set.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { opusSamples, readWebmOpus, webmToOgg } from "@/lib/audio";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.AI_GATEWAY_API_KEY = "k";
process.env.SDR_DEBOUNCE_MS = "0";

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/gravacao.webm", import.meta.url)));

/** Every page of an Ogg file, checking the capture pattern and the CRC Ogg readers verify. */
function oggPages(file: Uint8Array) {
  const pages: { type: number; granule: bigint; body: Uint8Array }[] = [];
  let at = 0;
  while (at < file.length) {
    expect(new TextDecoder().decode(file.subarray(at, at + 4))).toBe("OggS");
    const v = new DataView(file.buffer, file.byteOffset + at);
    const count = v.getUint8(26);
    const lacing = file.subarray(at + 27, at + 27 + count);
    const length = 27 + count + lacing.reduce((n, l) => n + l, 0);
    const page = file.slice(at, at + length);
    const crc = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    let c = 0;
    for (const b of page) {
      c ^= b << 24;
      for (let i = 0; i < 8; i++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      c >>>= 0;
    }
    expect(c).toBe(crc);
    pages.push({ type: v.getUint8(5), granule: v.getBigInt64(6, true), body: page.subarray(27 + count) });
    at += length;
  }
  return pages;
}

// EBML element with an "unknown" size, the way Chrome writes a recording that is still going
const unknown = (id: number[], ...children: Uint8Array[]) => new Uint8Array([...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...children.flatMap((c) => [...c])]);
const el = (id: number[], data: Uint8Array) => new Uint8Array([...id, 0x80 | data.length, ...data]);

describe("voice notes", () => {
  it("turns the browser's WebM recording into an Ogg Opus voice message without re-encoding", () => {
    const { packets } = readWebmOpus(fixture);
    const ogg = webmToOgg(fixture);
    const pages = oggPages(ogg);
    expect(new TextDecoder().decode(pages[0].body.subarray(0, 8))).toBe("OpusHead");
    expect(pages[0].type).toBe(0x02);
    expect(new TextDecoder().decode(pages[1].body.subarray(0, 8))).toBe("OpusTags");
    expect(pages.at(-1)!.type).toBe(0x04);
    // 3 seconds at 48 kHz, plus the encoder's lead-in
    const seconds = Number(pages.at(-1)!.granule) / 48000;
    expect(seconds).toBeGreaterThan(2.9);
    expect(seconds).toBeLessThan(3.2);
    expect(pages.slice(2).reduce((n, p) => n + p.body.length, 0)).toBe(packets.reduce((n, p) => n + p.length, 0));
  });

  it("reads a recording Chrome is still writing (sizes unknown)", () => {
    const head = new Uint8Array([...new TextEncoder().encode("OpusHead"), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    const packet = new Uint8Array([0xfc, 1, 2, 3]); // CELT 20 ms, one frame
    const block = el([0xa3], new Uint8Array([0x81, 0, 0, 0x80, ...packet]));
    const webm = unknown(
      [0x18, 0x53, 0x80, 0x67],
      el([0x16, 0x54, 0xae, 0x6b], el([0xae], new Uint8Array([...el([0x86], new TextEncoder().encode("A_OPUS")), ...el([0x63, 0xa2], head)]))),
      unknown([0x1f, 0x43, 0xb6, 0x75], el([0xe7], new Uint8Array([0])), block, block),
    );
    const read = readWebmOpus(webm);
    expect(read.packets).toEqual([packet, packet]);
    expect(read.head).toEqual(head);
    expect(Number(oggPages(webmToOgg(webm)).at(-1)!.granule)).toBe(1920);
  });

  it("counts the samples of each kind of Opus packet", () => {
    expect(opusSamples(new Uint8Array([0xfc]))).toBe(960); // CELT 20 ms
    expect(opusSamples(new Uint8Array([0x08]))).toBe(960); // SILK 20 ms
    expect(opusSamples(new Uint8Array([0x79]))).toBe(1920); // hybrid 20 ms, two frames
    expect(opusSamples(new Uint8Array([0xfb, 0x03]))).toBe(2880); // CELT 20 ms, three frames
  });
});

describe.skipIf(!dbUrl)("audio in a conversation", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let messaging: typeof import("@/lib/messaging");
  const calls: { url: string; body?: unknown }[] = [];
  let transcript = "Oi, quanto custa a franquia Home Office?";

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    messaging = await import("@/lib/messaging");
    vi.stubGlobal("fetch", async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body });
      if (url.endsWith("/media-1")) return Response.json({ url: "https://lookaside.fbsbx.com/audio-1", mime_type: "audio/ogg; codecs=opus" });
      if (url === "https://lookaside.fbsbx.com/audio-1") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/ogg" } });
      if (url.includes("ai-gateway.vercel.sh") || url.includes("api.groq.com")) return transcript ? Response.json({ text: transcript }) : Response.json({ error: "boom" }, { status: 500 });
      if (url.endsWith("/123/media")) return Response.json({ id: "up-1" });
      if (url.endsWith("/123/messages")) return Response.json({ messages: [{ id: `wamid.${calls.length}` }] });
      throw new Error(`unexpected ${url}`);
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    transcript = "Oi, quanto custa a franquia Home Office?";
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
  });

  it("keeps the lead's audio, writes it out and lets the AI answer the text", async () => {
    const { lead } = await leads.createLead({ name: "Rita", phone: "11977776666", source: "site" }, "teste");
    await db.lead.update({ where: { id: lead.id }, data: { status: "AI_QUALIFYING", sdrId: (await db.sdrAgent.findFirstOrThrow()).id } });
    await leads.handleInbound({ phone: "11977776666", body: "[audio recebido]", externalId: "a1", at: new Date(), audio: { id: "media-1", mimeType: "audio/ogg" } });
    const msg = await db.message.findFirstOrThrow({ where: { externalId: "a1" }, include: { media: true } });
    expect(msg).toMatchObject({ mediaKind: "audio", mediaType: "audio/ogg", body: "🎤 Oi, quanto custa a franquia Home Office?" });
    expect([...msg.media!.data]).toEqual([1, 2, 3]);
    expect(calls.find((c) => c.url.includes("ai-gateway"))!.body).toContain('"mediaType":"audio/ogg"');
    expect(await db.job.count({ where: { leadId: lead.id, type: "sdr.reply", status: "PENDING" } })).toBe(1);
  });

  it("uses Groq's free Whisper when its key is set", async () => {
    process.env.GROQ_API_KEY = "g";
    try {
      const { lead } = await leads.createLead({ name: "Rosa", phone: "11977774444", source: "site" }, "teste");
      await leads.handleInbound({ phone: "11977774444", body: "[audio recebido]", externalId: "a3", at: new Date(), audio: { id: "media-1", mimeType: "audio/ogg" } });
      expect((await db.message.findFirstOrThrow({ where: { externalId: "a3" } })).body).toBe("🎤 Oi, quanto custa a franquia Home Office?");
      const call = calls.find((c) => c.url.includes("api.groq.com"))!;
      const form = call.body as FormData;
      expect(form.get("model")).toBe("whisper-large-v3-turbo");
      expect(form.get("language")).toBe("pt");
      expect((form.get("file") as File).name).toBe("audio.ogg");
      expect(calls.some((c) => c.url.includes("ai-gateway"))).toBe(false);
      expect(lead.id).toBeTruthy();
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it("hands an audio it cannot write out to the team instead of the AI", async () => {
    transcript = "";
    const { lead } = await leads.createLead({ name: "Rui", phone: "11977775555", source: "site" }, "teste");
    await db.lead.update({ where: { id: lead.id }, data: { status: "AI_QUALIFYING", sdrId: (await db.sdrAgent.findFirstOrThrow()).id } });
    await leads.handleInbound({ phone: "11977775555", body: "[audio recebido]", externalId: "a2", at: new Date(), audio: { id: "media-1" } });
    expect((await db.message.findFirstOrThrow({ where: { externalId: "a2" } })).body).toBe("🎤 Áudio sem transcrição");
    expect(await db.job.count({ where: { leadId: lead.id, type: "sdr.reply" } })).toBe(0);
    expect(await db.task.findFirst({ where: { leadId: lead.id } })).toMatchObject({ title: expect.stringContaining("Ouvir o áudio") });
  });

  it("sends a recording from the CRM as a voice message, only inside the 24-hour window", async () => {
    const { lead } = await leads.createLead({ name: "Leo", phone: "11977774444", source: "site" }, "teste");
    await expect(messaging.sendAudioMessage(lead, fixture, "audio/webm;codecs=opus", "Wellington")).rejects.toThrow(/Janela de 24 h fechada/);
    const open = await db.lead.update({ where: { id: lead.id }, data: { lastInboundAt: new Date() } });
    calls.length = 0;
    const res = await messaging.sendAudioMessage(open, fixture, "audio/webm;codecs=opus", "Wellington");
    expect(res).toMatchObject({ ok: true, simulated: false });
    const upload = calls.find((c) => c.url.endsWith("/123/media"))!.body as FormData;
    expect(upload.get("type")).toBe("audio/ogg");
    const file = upload.get("file") as Blob;
    expect(new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()).subarray(0, 4))).toBe("OggS");
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/123/messages"))!.body as string)).toMatchObject({ type: "audio", audio: { id: "up-1" } });
    await messaging.transcribeSentAudio(res.ok && "messageId" in res ? res.messageId : "");
    expect(await db.message.findFirstOrThrow({ where: { leadId: lead.id, direction: "OUT", mediaKind: "audio" } })).toMatchObject({
      status: "SENT",
      mediaType: "audio/ogg",
      body: "🎤 Oi, quanto custa a franquia Home Office?",
    });
  });
});
