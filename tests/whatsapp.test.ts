import { describe, expect, it, vi } from "vitest";
import { adReferral, classifyError, isContactError, isUndelivered, isWindowOpen, normalizePhone, phoneVariants, verifySignature } from "@/lib/whatsapp";
import { renderTemplate } from "@/lib/email";
import { createHmac } from "node:crypto";

describe("whatsapp helpers", () => {
  it("counts as a contact error only what says the number can't get WhatsApp", () => {
    expect(isContactError(131026, "5511955554444")).toBe(true);
    // Invalid parameter on a number that isn't a phone, not on a good number (that would be our template)
    expect(isContactError(131009, "12")).toBe(true);
    expect(isContactError(131009, "11955554444")).toBe(false);
    expect(isContactError(131049, "11955554444")).toBe(false);
    expect(isContactError(131042, "11955554444")).toBe(false);
    expect(isContactError(null, "11955554444")).toBe(false);
  });

  it("counts as not delivered the number errors and Meta holding the message back, never account problems", () => {
    expect(isUndelivered(131026, "5511955554444")).toBe(true);
    expect(isUndelivered(131049, "5511955554444")).toBe(true);
    expect(isUndelivered(130472, "5511955554444")).toBe(true);
    expect(isUndelivered(131042, "5511955554444")).toBe(false);
    expect(isUndelivered(131009, "5511955554444")).toBe(false);
  });

  it("reads the click-to-WhatsApp ad a conversation came from", () => {
    const m = { from: "5511999990000", id: "w1", timestamp: "1", type: "text", text: { body: "Quero saber mais" } };
    expect(adReferral(m)).toBeNull();
    expect(adReferral({ ...m, referral: { source_type: "post", source_id: "9" } })).toBeNull();
    expect(
      adReferral({ ...m, referral: { source_type: "ad", source_id: "1203", source_url: "https://fb.me/x", headline: " Franquia   Banneg ", ctwa_clid: "clid" } }),
    ).toEqual({ campaign: "Anúncio: Franquia Banneg", adId: "1203", url: "https://fb.me/x", clickId: "clid" });
    expect(adReferral({ ...m, referral: { source_type: "ad", source_id: "1203" } })?.campaign).toBe("Anúncio: 1203");
  });

  it("opens the 24h window only after a recent inbound message", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(isWindowOpen(null, now)).toBe(false);
    expect(isWindowOpen(new Date("2026-10-14T00:00:00Z"), now)).toBe(true);
    expect(isWindowOpen(new Date("2026-10-13T11:59:00Z"), now)).toBe(false);
  });

  it("normalizes Brazilian phone numbers", () => {
    expect(normalizePhone("(11) 92013-8123")).toBe("5511920138123");
    expect(normalizePhone("+55 11 92013-8123")).toBe("5511920138123");
  });

  it("knows a mobile WhatsApp sends without the 9 is the same number", () => {
    expect(phoneVariants("61 98765-4321")).toEqual(["5561987654321", "556187654321"]);
    expect(phoneVariants("556187654321")).toEqual(["556187654321", "5561987654321"]);
    // Landlines (2 to 5) never had a 9 to lose
    expect(phoneVariants("(11) 3456-7890")).toEqual(["551134567890"]);
  });

  it("flags the Meta payment error as an account problem", () => {
    expect(classifyError(131042, "x")).toMatchObject({ accountLevel: true });
    expect(classifyError(131026, "Message undeliverable")).toEqual({ accountLevel: false, friendly: "Message undeliverable" });
  });

  it("checks the webhook signature", () => {
    process.env.WHATSAPP_APP_SECRET = "s3cret";
    const body = '{"a":1}';
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifySignature(body, sig)).toBe(true);
    expect(verifySignature(body, "sha256=00")).toBe(false);
    delete process.env.WHATSAPP_APP_SECRET;
  });

  it("renders email variables", () => {
    expect(renderTemplate("Olá {{nome}}, veja {{ apresentacao }}", { nome: "Ana", apresentacao: "https://x" })).toBe(
      "Olá Ana, veja https://x",
    );
  });
});

import { cleanName, mapRow, parseCsv, parseLocalDate } from "@/lib/csv";

describe("csv import", () => {
  it("parses a Kommo-style semicolon export with quotes", () => {
    const rows = parseCsv('﻿ID;Contato principal;Celular;Email comercial;Cidade\n123;"Silva; João";(41) 99999-0000;joao@x.com;Curitiba\n');
    expect(rows).toHaveLength(1);
    expect(mapRow(rows[0])).toMatchObject({
      name: "Silva; João",
      phone: "(41) 99999-0000",
      email: "joao@x.com",
      city: "Curitiba",
      externalId: "123",
    });
  });

  it("reads the old CRM's export: dates in São Paulo time, opt-out, lost and won", () => {
    const [row] = parseCsv(
      "id;nome;telefone;email;criado_em;ultimo_contato_em;etapa;status;nao_contatar;funil\nx1;MARIA;5511988887777;;2026-10-02 17:11;02/10/2026 18:00;Sem interesse / não contatar;lost;não;produtos\n",
    );
    expect(mapRow(row)).toMatchObject({
      name: "Maria",
      optOut: true,
      lost: true,
      won: false,
      funnel: "produtos",
      oldStage: "Sem interesse / não contatar",
      createdAt: new Date("2026-10-02T20:11:00Z"),
      lastContactAt: new Date("2026-10-02T21:00:00Z"),
    });
    expect(cleanName("fulano123@gmail.com")).toBeNull();
    expect(cleanName("❣️")).toBeNull();
    expect(cleanName("Sem nome (Kommo #1)")).toBeNull();
    expect(cleanName("José de Souza")).toBe("José de Souza");
    expect(parseLocalDate("16.10.2026")).toEqual(new Date("2026-10-16T15:00:00Z"));
    expect(parseLocalDate("02-10-2026 9:05")).toEqual(new Date("2026-10-02T12:05:00Z"));
    expect(parseLocalDate("2/1/2026")).toEqual(new Date("2026-01-02T15:00:00Z"));
    expect(parseLocalDate("31/02/2026")).toBeNull();
    expect(parseLocalDate("ontem")).toBeNull();
  });
});

describe("Meta send status", () => {
  it("reads the payment block from health_status without sending anything", async () => {
    const { whatsappSendStatus } = await import("@/lib/integrations");
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    const reply = (health: unknown) => async () => new Response(JSON.stringify({ health_status: health }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      reply({
        can_send_message: "BLOCKED",
        entities: [
          { entity_type: "PHONE_NUMBER", can_send_message: "AVAILABLE" },
          { entity_type: "WABA", can_send_message: "BLOCKED", errors: [{ error_code: 141006, error_description: "Problema com a forma de pagamento." }] },
        ],
      }),
    );
    expect(await whatsappSendStatus()).toEqual({ canSend: false, problem: { code: 141006, message: "Problema com a forma de pagamento." } });
    vi.stubGlobal("fetch", reply({ can_send_message: "AVAILABLE", entities: [] }));
    expect(await whatsappSendStatus()).toEqual({ canSend: true, problem: null });
    vi.unstubAllGlobals();
  });
});
