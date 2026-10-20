import type { Lead, LeadStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { cancelJobs, enqueueDebounced } from "./queue";
import { cancelGreetings, cancelRuleJobs, scheduleAnswerRules, scheduleStageRules } from "./automations";
import { isWindowOpen, normalizePhone, numberName, phoneVariants } from "./whatsapp";
import { AUDIO_MARK, downloadWhatsAppMedia, transcribe } from "./audio";
import { SEND_ERROR_STAGE, sendWhatsApp } from "./messaging";
import { REFERRAL_FUNNEL, STAGE_KEYS } from "./plan";
import { queueCapi } from "./meta-capi";

/** A stage of the given funnel by its AI key; null when that funnel has no such stage. */
export async function stageByKey(key: string, pipelineId: string) {
  return db.stage.findUnique({ where: { pipelineId_key: { pipelineId, key } } });
}

/** A funnel by its short name ("sindicatos") or its name, ignoring accents and case. */
export async function pipelineByRef(ref: string | null | undefined) {
  const key = slugify(ref ?? "");
  if (!key) return null;
  const all = await db.pipeline.findMany({ select: { id: true, slug: true, name: true } });
  return all.find((p) => p.slug === key) ?? all.find((p) => slugify(p.name) === key) ?? null;
}

export function slugify(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function defaultPipeline() {
  const p = (await db.pipeline.findFirst({ where: { isDefault: true } })) ?? (await db.pipeline.findFirst({ orderBy: { position: "asc" } }));
  if (!p) throw new Error("Nenhum funil cadastrado. Rode o seed (npm run db:seed).");
  return p;
}

/** Picks the active SDR with the fewest leads in qualification, so Duda and Alice share the load. */
export async function pickSdr() {
  const agents = await db.sdrAgent.findMany({
    where: { active: true },
    // Leads of a funnel with its own SDR are not part of the round robin
    include: { _count: { select: { leads: { where: { status: { in: ["NEW", "AI_QUALIFYING"] }, pipeline: { sdrId: null } } } } } },
  });
  agents.sort((a, b) => a._count.leads - b._count.leads);
  return agents[0] ?? null;
}

/** What a funnel gives the conversations that start in it: its WhatsApp number (null = the main one) and its own SDR, if active. */
export async function funnelStart(pipelineId: string) {
  const p = await db.pipeline.findUnique({ where: { id: pipelineId }, select: { whatsappNumberId: true, sdr: true } });
  return { whatsappNumberId: p?.whatsappNumberId ?? null, sdr: p?.sdr?.active ? p.sdr : null };
}

/** The SDR who takes a new lead in this funnel: the funnel's own one, else the round robin. */
export async function sdrFor(pipelineId: string) {
  return (await funnelStart(pipelineId)).sdr ?? (await pickSdr());
}

export type NewLeadInput = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  source: string;
  campaign?: string | null;
  externalId?: string | null;
  pipelineId?: string | null;
  // Old leads from Kommo go to reactivation instead of getting a welcome message right away
  reactivation?: boolean;
  // Extra answers the form already collected (produto, empresa...), shown to the AI
  qualification?: Record<string, string>;
  // Imports keep the date the lead first came in, so "newest first" means something
  createdAt?: Date | null;
  stageId?: string | null;
  // Created by someone on the team: they know it exists, so it does not light the "new lead" alert
  seen?: boolean;
  // The number the lead wrote to (null = the main one); left out = the funnel's number
  whatsappNumberId?: string | null;
  // A person on the team takes it: no stage automations and the AI off
  byTeam?: boolean;
};

/** The lead with this number, or else the oldest one with it written with or without the 9. */
async function leadByPhone(phone: string) {
  return (
    (await db.lead.findUnique({ where: { phone } })) ??
    (await db.lead.findFirst({ where: { phone: { in: phoneVariants(phone) } }, orderBy: { createdAt: "asc" } }))
  );
}

export async function createLead(input: NewLeadInput, actor: string) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone) {
    const existing = await leadByPhone(phone);
    if (existing) {
      await logEvent(existing.id, "lead.duplicate", actor, `Entrou de novo pela origem "${input.source}".`);
      return { lead: existing, created: false };
    }
  }
  const chosen = input.stageId ? await db.stage.findUnique({ where: { id: input.stageId } }) : null;
  const pipelineId = chosen?.pipelineId ?? (input.pipelineId || (await defaultPipeline()).id);
  const stage =
    chosen ??
    (await stageByKey(STAGE_KEYS.NEW, pipelineId)) ??
    (await db.stage.findFirstOrThrow({ where: { pipelineId }, orderBy: { position: "asc" } }));
  const funnel = await funnelStart(pipelineId);
  const sdr = funnel.sdr ?? (await pickSdr());
  let lead: Lead;
  try {
    lead = await db.lead.create({
      data: {
        name: input.name?.trim() || null,
        phone,
        email: input.email?.trim().toLowerCase() || null,
        city: input.city?.trim() || null,
        state: input.state?.trim() || null,
        source: input.source,
        campaign: input.campaign ?? null,
        externalId: input.externalId ?? null,
        pipelineId,
        stageId: stage.id,
        sdrId: sdr?.id,
        // The conversation starts on the funnel's number; a lead who wrote first stays on the number it wrote to
        whatsappNumberId: input.whatsappNumberId !== undefined ? input.whatsappNumberId : funnel.whatsappNumberId,
        ...(input.qualification && { qualification: input.qualification }),
        ...(input.createdAt && { createdAt: input.createdAt, stageEnteredAt: input.createdAt }),
        ...(input.seen && { seenAt: new Date() }),
        ...(input.byTeam && { aiPaused: true }),
      },
    });
  } catch (e) {
    // Two posts with the same number at the same moment: the second gets the lead the first one created
    const existing = (e as { code?: string }).code === "P2002" && phone ? await leadByPhone(phone) : null;
    if (!existing) throw e;
    return { lead: existing, created: false };
  }
  await logEvent(lead.id, "lead.created", actor, `Lead criado (origem: ${input.source}).`);
  await queueCapi(db, lead, stage).catch(() => console.error("Meta CAPI: falha ao registrar evento na fila."));
  if (!input.reactivation && !input.byTeam) await startAutomations(lead);
  return { lead, created: true };
}

/** Runs the automations of the stage the lead is in, as if it had just arrived there. */
export async function startAutomations(lead: Lead) {
  await scheduleStageRules(lead);
}

/**
 * A lead's audio: kept so the team can listen in the CRM, and written out so the AI can read it.
 * Returns what the lead said, or null when it could not be heard (the team then listens).
 */
export async function receiveAudio(messageId: string, mediaId: string) {
  try {
    const file = await downloadWhatsAppMedia(mediaId);
    await db.messageMedia.create({ data: { messageId, mimeType: file.mimeType, data: Buffer.from(file.data) } });
    await db.message.update({ where: { id: messageId }, data: { mediaType: file.mimeType } });
    const text = await transcribe(file.data, file.mimeType);
    if (!text) throw new Error("O áudio não tem fala que dê para entender.");
    await db.message.update({ where: { id: messageId }, data: { body: `${AUDIO_MARK} ${text}` } });
    return text;
  } catch (e) {
    const msg = await db.message.update({ where: { id: messageId }, data: { body: `${AUDIO_MARK} Áudio sem transcrição` } });
    await logEvent(msg.leadId, "audio.failed", "WhatsApp", `Não deu para transcrever o áudio: ${(e as Error).message}`);
    return null;
  }
}

export async function handleInbound(input: {
  phone: string;
  profileName?: string;
  body: string;
  externalId: string;
  at: Date;
  audio?: { id: string; mimeType?: string };
  // Meta's id of our number the lead wrote to (the webhook's metadata.phone_number_id)
  phoneNumberId?: string | null;
}) {
  const phone = normalizePhone(input.phone);
  const dup = await db.message.findUnique({ where: { externalId: input.externalId } });
  if (dup) return null;
  // null = the main number; undefined = not known, the lead keeps the number it is on
  const numberId =
    input.phoneNumberId === undefined ? undefined : input.phoneNumberId && input.phoneNumberId !== process.env.WHATSAPP_PHONE_NUMBER_ID ? input.phoneNumberId : null;
  const known = await leadByPhone(phone);
  // The portal's ready message carries the code of the store's referral ("Pedido ABC123") whose client has not written yet
  const referral = await waitingReferral(input.body);
  // Set when a person answers this message instead of the AI
  let forTeam: string | null = null;
  let lead = known;
  if (known && referral && referral.id !== known.id) {
    // A phone the CRM knows takes the referral only when it is plainly its client: not another referral's phone (the
    // store's own), and the same name. Else a person sorts it out and the referral keeps the phone the store typed
    if (!known.externalId?.startsWith("portal:") && sameFirstName(known.name, referral.name)) lead = await joinReferral(referral, known);
    else forTeam = await otherReferralCode(known, referral);
  }
  lead ??= (await leadByEmailCode(input.body, phone)) ?? (referral && (await takeReferral(referral, phone)));
  if (!lead) {
    // Someone writing to a funnel's own number starts in that funnel, with its SDR
    const funnel = numberId ? await numberFunnel(numberId) : null;
    // A number of the account that no funnel uses yet (still being set up): the team answers, not the default funnel's AI
    const unassigned = !!numberId && !funnel && !!process.env.WHATSAPP_PHONE_NUMBER_ID;
    const created = await createLead(
      { phone, name: input.profileName, source: "whatsapp", pipelineId: funnel?.id, whatsappNumberId: numberId, byTeam: unassigned },
      "WhatsApp",
    );
    lead = created.lead;
    if (unassigned && created.created)
      await logEvent(lead.id, "whatsapp.unassigned_number", "WhatsApp", `Escreveu para ${await numberName(numberId)}, que nenhum funil usa: a IA não responde, a equipe atende. Escolha o número do funil em Funis.`);
    // The lead wrote first, so the SDR answers the message instead of sending a cold opening (or the stage's greeting)
    await cancelJobs(lead.id, ["sdr.first_contact"]);
  } else if (numberId !== undefined && numberId !== lead.whatsappNumberId) {
    // We answer where the person writes: the conversation goes on from the number the lead wrote to, with the SDR of
    // the funnel that talks from it (who wrote "Oi, Alice!" to Alice's number gets Alice, not the SDR of the other number)
    const sdr = numberId ? (await numberFunnel(numberId, lead.pipelineId))?.sdr : null;
    const takes = sdr?.active && sdr.id !== lead.sdrId ? sdr : null;
    lead = await db.lead.update({ where: { id: lead.id }, data: { whatsappNumberId: numberId, ...(takes && { sdrId: takes.id }) } });
    await logEvent(
      lead.id,
      "whatsapp.number_changed",
      "WhatsApp",
      `O lead escreveu para ${await numberName(numberId)}: a conversa segue por ele${takes ? `, com a ${takes.name}` : ""}.`,
      { whatsappNumberId: numberId, ...(takes && { sdrId: takes.id }) },
    );
  }
  lead = await backFromSendError(lead);
  const msg = await db.message.create({
    data: {
      leadId: lead.id,
      channel: "WHATSAPP",
      direction: "IN",
      body: input.audio ? `${AUDIO_MARK} Áudio` : input.body,
      author: lead.name ?? "Lead",
      status: "RECEIVED",
      externalId: input.externalId,
      createdAt: input.at,
      ...(input.audio && { mediaKind: "audio", mediaType: input.audio.mimeType ?? null }),
    },
  });
  lead = await db.lead.update({
    where: { id: lead.id },
    data: { lastInboundAt: input.at, name: lead.name ?? input.profileName ?? null },
  });
  // A greeting still waiting for the lead does not go: it wrote. Also when Meta's time of the message is older than the
  // greeting (the store's referral got here a moment after the client pressed send)
  await cancelGreetings(lead.id);
  const said = input.audio ? await receiveAudio(msg.id, input.audio.id) : input.body;
  if (said !== null && isStopRequest(said)) return optOut(lead);
  // The lead answered: the "sem resposta" clock starts over
  await cancelRuleJobs(lead.id, "idle");
  await scheduleStageRules(lead, "idle");
  if (said === null) {
    await ensureTask(lead.id, lead.ownerId, "Ouvir o áudio do lead: não deu para transcrever");
    return lead;
  }
  // A tapped button ("Quero ver") moves the lead on and the next stage's message answers it
  const answered = await scheduleAnswerRules(lead, said, input.externalId);
  if (answered.matched && !answered.aiReplies) return lead;
  if (forTeam) {
    // Nor an answer still waiting for a line sent just before: it would go out with this code in the talk
    await cancelJobs(lead.id, ["sdr.reply"]);
    await ensureTask(lead.id, lead.ownerId, forTeam);
    return lead;
  }
  if (lead.sdrId && !lead.aiPaused && ["NEW", "AI_QUALIFYING", "QUALIFIED", "NURTURING"].includes(lead.status)) {
    // Wait a few seconds so several short messages get one answer
    await enqueueDebounced("sdr.reply", lead.id, Number(process.env.SDR_DEBOUNCE_MS ?? 15_000));
  } else {
    await ensureTask(lead.id, lead.ownerId, "Responder mensagem do lead no WhatsApp");
  }
  return lead;
}

/**
 * The "Chamar no WhatsApp" button of the e-mail writes the lead's code. A lead whose number WhatsApp could
 * not reach comes back from another number: the number is fixed and the conversation stays in its history.
 */
async function leadByEmailCode(body: string, phone: string) {
  const code = body.match(/c[oó]digo:?\s*([a-z0-9]{6})\b/i)?.[1];
  if (!code) return null;
  const lead = await db.lead.findFirst({ where: { id: { endsWith: code.toLowerCase() } } });
  if (!lead) return null;
  await logEvent(lead.id, "lead.phone_changed", "WhatsApp", `Chamou no WhatsApp pelo botão do e-mail, de outro número: ${lead.phone ?? "sem número"} → ${phone}.`);
  return db.lead.update({ where: { id: lead.id }, data: { phone } });
}

/** The code of a store's referral in a message ("Pedido ABC123", the end of the portal's id in the lead's ref), upper case. */
export function referralCode(body: string) {
  return body.match(/\bpedido:?\s*([a-z0-9]{6})\b/i)?.[1].toUpperCase() ?? null;
}

const codeOf = (ref: string | null) => ref?.slice(-6).toUpperCase() ?? "";

/** The same person as far as a name tells: the first names match, accents and case aside. */
function sameFirstName(a: string | null | undefined, b: string | null | undefined) {
  const first = (s: string | null | undefined) => slugify(s ?? "").split("-")[0];
  return !!first(a) && first(a) === first(b);
}

/** The store's referral whose code the message carries, while its client has not written yet. */
async function waitingReferral(body: string) {
  const code = referralCode(body);
  if (!code) return null;
  return db.lead.findFirst({
    where: { externalId: { startsWith: "portal:", endsWith: code, mode: "insensitive" }, lastInboundAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * A client who writes with the referral's code from a number the CRM does not have is that referral's lead: the number
 * is fixed and the conversation goes on with the referral's store, product and greeting.
 */
async function takeReferral(referral: Lead, phone: string) {
  await logEvent(
    referral.id,
    "lead.phone_changed",
    "WhatsApp",
    `Escreveu com o código da indicação (pedido ${codeOf(referral.externalId)}), de outro número: ${referral.phone ?? "sem número"} → ${phone}.`,
  );
  return db.lead.update({ where: { id: referral.id }, data: { phone } });
}

/**
 * The client of a store's referral wrote, with its code, from a phone the CRM already had: the referral goes on in that
 * lead, as if the store had typed this phone (back to the referral's funnel when closed or queued, a task for the team
 * either way), with the referral's file. The lead the referral had made with the phone the store typed, which never
 * wrote, closes as a duplicate, so its greeting does not go.
 */
async function joinReferral(referral: Lead, into: Lead) {
  const q = referral.qualification as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const store = text(q.parceiro);
  if (store) await referExisting(into.id, referral.pipelineId, store, text(q.produto), "WhatsApp");
  // The store's file on the client, and the e-mail it typed (the way in when WhatsApp does not reach)
  await db.leadEvent.updateMany({ where: { leadId: referral.id, type: "lead.form" }, data: { leadId: into.id } });
  const now = await db.lead.findUniqueOrThrow({ where: { id: into.id } });
  await db.lead.update({
    where: { id: into.id },
    data: { email: now.email ?? referral.email, city: now.city ?? referral.city, state: now.state ?? referral.state },
  });
  await logEvent(
    into.id,
    "lead.referral_joined",
    "WhatsApp",
    `Escreveu com o código da indicação${store ? ` da ${store}` : ""} (pedido ${codeOf(referral.externalId)}), que tinha chegado com o número ${referral.phone ?? "sem número"}: a indicação segue neste lead.`,
    { leadId: referral.id },
  );
  await closeDuplicate(referral, into);
  return db.lead.findUniqueOrThrow({ where: { id: into.id } });
}

/**
 * A lead that turned out to be another one's: closed as a duplicate, and nothing scheduled for it goes. It gives up the
 * referral's ref (kept on its timeline), so its code waits for nobody and the store sending the referral again finds the
 * lead it went on in, by the store's file there.
 */
async function closeDuplicate(dup: Lead, into: Lead) {
  const reason = `Duplicado: o cliente escreveu de ${into.phone ?? "outro número"}, que já é de outro lead.`;
  const closed = { lostReason: reason, aiPaused: true, externalId: null };
  const lost = await db.stage.findMany({ where: { pipelineId: dup.pipelineId, kind: "LOST" }, orderBy: { position: "asc" } });
  const to = lost.find((s) => s.key === STAGE_KEYS.LOST) ?? lost.find((s) => s.key !== SEND_ERROR_STAGE.key);
  if (to) await moveLead(dup.id, to.id, "WhatsApp", closed);
  else await db.lead.update({ where: { id: dup.id }, data: closed });
  // Not even the lost stage's own messages: they would go to the phone the store typed
  await cancelRuleJobs(dup.id, "all");
  await cancelJobs(dup.id, ["sdr.first_contact", "sdr.reply", "email.send"]);
  await logEvent(
    dup.id,
    "lead.duplicate",
    "WhatsApp",
    `O cliente escreveu com o código desta indicação de ${into.phone ?? "outro número"}, que já é de ${into.name ?? "outro lead"}: a indicação seguiu lá.`,
    { leadId: into.id, ...(dup.externalId && { ref: dup.externalId }) },
  );
}

/**
 * The lead a store's referral went on in, for the duplicate it left closed (closeDuplicate): the store referring the same
 * client again with the phone it typed then goes on there too, instead of reopening the duplicate. null for any other lead.
 */
export async function joinedInto(dup: Lead, name: string | null | undefined) {
  if (dup.status !== "LOST" || !sameFirstName(dup.name, name)) return null;
  const events = await db.leadEvent.findMany({ where: { leadId: dup.id, type: "lead.duplicate" }, orderBy: { createdAt: "desc" }, select: { data: true } });
  const into = events.map((e) => (e.data as { leadId?: unknown } | null)?.leadId).find((id): id is string => typeof id === "string");
  return into ? db.lead.findUnique({ where: { id: into } }) : null;
}

/**
 * A phone the CRM has for someone who is not plainly the referral's client wrote with the code of a referral still waiting
 * for it (the store's own phone sending the next client's message, or the client referred again with another phone typed):
 * a person sorts out who it is, and the waiting referral's greeting still goes to the phone the store typed.
 */
async function otherReferralCode(known: Lead, referral: Lead) {
  const code = codeOf(referral.externalId);
  const who = referral.name ?? "outro cliente";
  await logEvent(
    known.id,
    "lead.referral_code",
    "WhatsApp",
    `Escreveu com o código da indicação de ${who} (pedido ${code}): confira quem está escrevendo. A indicação de ${who} segue no número que a loja informou.`,
    { leadId: referral.id },
  );
  await logEvent(
    referral.id,
    "lead.referral_code",
    "WhatsApp",
    `O código desta indicação (pedido ${code}) chegou de ${known.phone}, que no CRM é de ${known.name ?? "outro lead"}: a equipe confere.`,
    { leadId: known.id },
  );
  return `Conferir quem escreveu: veio o pedido ${code}, da indicação de ${who}`;
}

/** Where a referral starts in a funnel: its "novo" stage, else its first open one. */
async function entryStage(pipelineId: string) {
  return (await stageByKey(STAGE_KEYS.NEW, pipelineId)) ?? (await db.stage.findFirst({ where: { pipelineId, kind: "OPEN" }, orderBy: { position: "asc" } }));
}

/**
 * A partner store referred a contact the CRM already had. A closed or queued lead starts over in the referral's funnel,
 * with this store and product, so the greeting goes out; one someone may be working (or a client already) stays where it
 * is. Either way a person decides, and a task tells them.
 */
export async function referExisting(leadId: string, pipelineId: string | undefined, parceiro: string, produto: string | undefined, actor: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: true } });
  const qualification = (lead.qualification ?? {}) as Record<string, unknown>;
  const closed = lead.stage.kind === "LOST" && lead.stage.key !== SEND_ERROR_STAGE.key;
  const entry = pipelineId && (closed || lead.stage.key === "fila") && !lead.whatsappOptOut ? await entryStage(pipelineId) : null;
  let moved = false;
  if (entry) {
    // Starts over like a new lead: this store and product (never an old product), an SDR and the AI on
    const rest = { ...qualification };
    delete rest.produto;
    // A new conversation, on the funnel's number with its SDR. Meta's 24 h window is per number: a lead who
    // wrote in the last 24 h stays on the number (and with the SDR) it is talking to
    const funnel = await funnelStart(entry.pipelineId);
    const talking = isWindowOpen(lead.lastInboundAt);
    const restarted = await moveLead(leadId, entry.id, actor, {
      qualification: { ...rest, parceiro, ...(produto && { produto }), [REFERRAL_FUNNEL]: entry.pipelineId },
      status: "NEW",
      lostReason: null,
      aiPaused: false,
      whatsappNumberId: talking ? lead.whatsappNumberId : funnel.whatsappNumberId,
      sdrId: (talking ? (lead.sdrId ?? funnel.sdr?.id) : (funnel.sdr?.id ?? lead.sdrId)) ?? (await pickSdr())?.id ?? null,
    });
    // The client wrote before the referral got here (the store's QR code, a referral sent again later) and nobody has
    // answered yet: the AI answers that message now, with this store and product, instead of the greeting that waits
    if (talking && restarted.sdrId) {
      const last = await db.message.findFirst({ where: { leadId, channel: "WHATSAPP" }, orderBy: { createdAt: "desc" }, select: { direction: true } });
      if (last?.direction === "IN" && (await cancelGreetings(leadId))) await enqueueDebounced("sdr.reply", leadId, Number(process.env.SDR_DEBOUNCE_MS ?? 15_000));
    }
    moved = true;
  } else if (!qualification.parceiro || (produto && !qualification.produto) || (pipelineId && !qualification[REFERRAL_FUNNEL])) {
    // Only fills what is missing: the lead's current conversation keeps the store and product it already has. The funnel
    // the store referred it to goes along: in another funnel the AI keeps that funnel's talk while a person decides
    await db.lead.update({
      where: { id: leadId },
      data: {
        qualification: {
          ...qualification,
          parceiro: qualification.parceiro ?? parceiro,
          ...(produto && !qualification.produto && { produto }),
          ...(pipelineId && !qualification[REFERRAL_FUNNEL] && { [REFERRAL_FUNNEL]: pipelineId }),
        },
      },
    });
  }
  // A person decides what to do with a contact the CRM already had, and the alert tells them
  const title = `Nova indicação da ${parceiro}${produto ? `: cotar ${produto}` : ""}`;
  await ensureTask(leadId, lead.ownerId, title);
  // The same store referring again (a renewal next year): the open task rings again
  await db.task.updateMany({ where: { leadId, title, doneAt: null }, data: { dueAt: new Date() } });
  return { moved };
}

/**
 * The lead whose WhatsApp carries the ready message of a referral that had not reached the CRM yet ("Pedido ABC123", the
 * end of its ref): the client wrote first, maybe from a phone other than the one the store typed. own: the conversation
 * began with that message, so the lead is this referral's; otherwise it is a contact the CRM already had, with the
 * referral's name. null when nobody wrote it, or when only someone else did (another referral's lead, a contact with
 * another name): the referral then keeps the phone the store typed. Someone else sending it first does not hide the
 * client's own.
 */
export async function leadThatQuoted(ref: string, name: string | null | undefined) {
  const code = /^portal:.*([a-z0-9]{6})$/i.exec(ref)?.[1].toUpperCase();
  if (!code) return null;
  const quoting = await db.message.findMany({
    where: { channel: "WHATSAPP", direction: "IN", body: { contains: code, mode: "insensitive" }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    orderBy: { createdAt: "asc" },
    include: { lead: true },
    take: 20,
  });
  // A conversation that began with the message is the referral's own; else a contact the CRM had with the referral's name
  let named: { lead: Lead; own: false } | null = null;
  for (const hit of quoting) {
    if (referralCode(hit.body) !== code || hit.lead.externalId?.startsWith("portal:")) continue;
    const before = await db.message.count({ where: { leadId: hit.leadId, createdAt: { lt: hit.createdAt } } });
    if (hit.lead.source === "whatsapp" && !hit.lead.externalId && before === 0) return { lead: hit.lead, own: true };
    if (!named && sameFirstName(hit.lead.name, name)) named = { lead: hit.lead, own: false };
  }
  return named;
}

/**
 * The client wrote the store's ready message before the referral got here, on a conversation that began with it: the lead
 * is this referral's, as if the referral had made it. It takes the referral's data (the name the store typed, e-mail, city,
 * source, ref, store and product) and nobody gets a task. When the number it wrote to left it in another funnel, it goes to
 * the referral's, on the number and with the SDR it is talking to, and the AI answers a message nobody answered yet.
 */
export async function adoptReferral(lead: Lead, input: NewLeadInput, actor: string) {
  await db.lead.update({
    where: { id: lead.id },
    data: {
      name: input.name?.trim() || lead.name,
      email: lead.email ?? (input.email?.trim().toLowerCase() || null),
      city: lead.city ?? (input.city?.trim() || null),
      state: lead.state ?? (input.state?.trim() || null),
      source: input.source,
      campaign: input.campaign ?? lead.campaign,
      externalId: input.externalId ?? null,
      qualification: { ...(lead.qualification as Prisma.JsonObject), ...input.qualification },
    },
  });
  const typed = input.phone ? normalizePhone(input.phone) : null;
  const elsewhere = typed && lead.phone && !phoneVariants(lead.phone).includes(typed) ? ` A loja informou o número ${typed}; o cliente escreveu de ${lead.phone}.` : "";
  await logEvent(lead.id, "lead.referral_joined", actor, `A indicação chegou depois de o cliente escrever com o código dela: segue nesta conversa.${elsewhere}`);
  const entry = input.pipelineId && input.pipelineId !== lead.pipelineId ? await entryStage(input.pipelineId) : null;
  if (entry) {
    const funnel = await funnelStart(entry.pipelineId);
    // Nobody answered it yet: the funnel's SDR takes it (the ready message greets her by name)
    const answered = await db.message.count({ where: { leadId: lead.id, channel: "WHATSAPP", direction: "OUT" } });
    await moveLead(lead.id, entry.id, actor, {
      status: "NEW",
      lostReason: null,
      aiPaused: lead.whatsappOptOut,
      whatsappNumberId: lead.whatsappNumberId,
      sdrId: (answered ? (lead.sdrId ?? funnel.sdr?.id) : (funnel.sdr?.id ?? lead.sdrId)) ?? (await pickSdr())?.id ?? null,
    });
    // It wrote first: no greeting. A message nobody answered (a number no funnel used left it to the team) gets the AI's answer
    await cancelGreetings(lead.id);
    const last = await db.message.findFirst({ where: { leadId: lead.id, channel: "WHATSAPP" }, orderBy: { createdAt: "desc" }, select: { direction: true } });
    if (!lead.whatsappOptOut && last?.direction === "IN") await enqueueDebounced("sdr.reply", lead.id, Number(process.env.SDR_DEBOUNCE_MS ?? 15_000));
  }
  return db.lead.findUniqueOrThrow({ where: { id: lead.id } });
}

/** The funnel that starts its conversations on this number (the lead's own funnel first), with its SDR; null when none does. */
async function numberFunnel(numberId: string, preferPipelineId?: string) {
  const funnels = await db.pipeline.findMany({
    where: { whatsappNumberId: numberId },
    orderBy: [{ isDefault: "desc" }, { position: "asc" }],
    select: { id: true, sdr: true },
  });
  return funnels.find((f) => f.id === preferPipelineId) ?? funnels[0] ?? null;
}

/** A lead in "Erro no WhatsApp" wrote: the number works, so it goes back to the conversation. */
async function backFromSendError(lead: Lead) {
  const stage = await db.stage.findUnique({ where: { id: lead.stageId } });
  if (stage?.key !== SEND_ERROR_STAGE.key) return lead;
  const back =
    (await stageByKey(STAGE_KEYS.AI_QUALIFYING, lead.pipelineId)) ??
    (await db.stage.findFirst({ where: { pipelineId: lead.pipelineId, kind: "OPEN" }, orderBy: { position: "asc" } }));
  if (!back) return lead;
  return moveLead(lead.id, back.id, "WhatsApp", { status: "AI_QUALIFYING", aiPaused: !lead.sdrId, lostReason: null });
}

// The "Parar mensagens" button of the templates, or the lead typing it
const STOP_WORDS = new Set(["parar mensagens", "parar", "pare", "sair", "stop", "cancelar", "descadastrar"]);

export function isStopRequest(body: string) {
  return STOP_WORDS.has(body.trim().toLowerCase().replace(/[.!]+$/, ""));
}

/** The lead asked to stop: no automatic WhatsApp or e-mail from now on, and the AI steps out. */
export async function optOut(lead: Lead) {
  if (lead.whatsappOptOut) return lead;
  const updated = await db.lead.update({
    where: { id: lead.id },
    data: { whatsappOptOut: true, emailOptOut: true, aiPaused: true },
  });
  await cancelRuleJobs(lead.id, "all");
  await cancelJobs(lead.id, ["sdr.first_contact", "sdr.reply", "email.send"]);
  await logEvent(lead.id, "lead.opt_out", "WhatsApp", "O lead pediu para parar as mensagens: automações, e-mails e IA desligados para ele.");
  try {
    await sendWhatsApp(updated, "Tudo certo, não vou mais te mandar mensagens automáticas. Se quiser retomar a conversa, é só escrever aqui.", "Automação");
  } catch (e) {
    await logEvent(lead.id, "whatsapp.failed", "Automação", `Confirmação de saída não enviada: ${(e as Error).message}`);
  }
  return updated;
}

export async function ensureTask(leadId: string, userId: string | null, title: string, dueAt = new Date()) {
  const open = await db.task.findFirst({ where: { leadId, title, doneAt: null } });
  if (open) return open;
  return db.task.create({ data: { leadId, userId, title, dueAt } });
}

const STATUS_BY_STAGE_KEY = Object.fromEntries(Object.entries(STAGE_KEYS).map(([status, key]) => [key, status])) as Record<
  string,
  LeadStatus
>;

/** Moves a lead (drag and drop, the AI or a rule) and starts the new stage's automations. */
export async function moveLead(leadId: string, stageId: string, actor: string, extra: Prisma.LeadUncheckedUpdateInput = {}) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: true } });
  const stage = await db.stage.findUniqueOrThrow({ where: { id: stageId } });
  if (lead.stageId === stageId && Object.keys(extra).length === 0) return lead;
  const entering = lead.stageId !== stageId;
  const status =
    (stage.key && STATUS_BY_STAGE_KEY[stage.key]) || (stage.kind === "WON" ? "WON" : stage.kind === "LOST" ? "LOST" : lead.status);
  // Into another funnel: a lead with no WhatsApp yet starts on that funnel's number (and SDR, when it has one);
  // a lead already talking keeps its number, so a conversation never switches number midway
  let start: Prisma.LeadUncheckedUpdateInput = {};
  if (stage.pipelineId !== lead.pipelineId && extra.whatsappNumberId === undefined && !(await db.message.count({ where: { leadId, channel: "WHATSAPP" } }))) {
    const funnel = await funnelStart(stage.pipelineId);
    start = { whatsappNumberId: funnel.whatsappNumberId, ...(funnel.sdr && extra.sdrId === undefined && { sdrId: funnel.sdr.id }) };
  }
  const updated = await db.lead.update({
    where: { id: leadId },
    data: {
      stageId,
      pipelineId: stage.pipelineId,
      status,
      ...(entering && { stageEnteredAt: new Date() }),
      ...(entering && stage.kind === "WON" && { wonAt: new Date() }),
      ...(entering && stage.kind !== "WON" && lead.stage.kind === "WON" && { wonAt: null }),
      ...start,
      ...extra,
    },
  });
  if (entering) {
    await queueCapi(db, updated, stage).catch(() => console.error("Meta CAPI: falha ao registrar evento na fila."));
    const crossed = stage.pipelineId !== lead.pipelineId ? " (outro funil)" : "";
    await logEvent(leadId, "stage.changed", actor, `${lead.stage.name} → ${stage.name}${crossed}`);
    if (stage.kind !== "OPEN") {
      // Closing the deal stops everything that was still scheduled for this lead
      await cancelRuleJobs(leadId, "all");
      await cancelJobs(leadId, ["sdr.first_contact", "sdr.reply", "email.send", "meeting.reminder"]);
    } else {
      await cancelRuleJobs(leadId, "stage");
    }
    await scheduleStageRules(updated);
  }
  return updated;
}
