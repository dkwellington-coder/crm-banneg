// node --test: what the gateway posts to the CRM, in the shape Uazapi uses (the CRM's parser is tested in tests/suporte.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.ADMIN_TOKEN = "x".repeat(32);
const { toPayload } = await import("./server.mjs");
const s = { sentByApi: new Set(["SENT1"]) };

test("client text, with the phone and the name", () => {
  const p = toPayload(s, { key: { remoteJid: "5517999990000@s.whatsapp.net", fromMe: false, id: "A1" }, pushName: "Carla", messageTimestamp: 1763557200, message: { conversation: "Oi" } });
  assert.equal(p.EventType, "messages");
  assert.deepEqual(p.chat, { wa_chatid: "5517999990000@s.whatsapp.net", phone: "5517999990000", wa_contactName: "Carla" });
  assert.equal(p.message.text, "Oi");
  assert.equal(p.message.messageTimestamp, 1763557200000);
  assert.equal(p.message.fromMe, false);
  assert.equal(p.message.wasSentByApi, false);
});

test("own message sent by the CRM is marked; one typed on the phone is not", () => {
  const sent = toPayload(s, { key: { remoteJid: "5517999990000@s.whatsapp.net", fromMe: true, id: "SENT1" }, message: { extendedTextMessage: { text: "Olá" } } });
  assert.equal(sent.message.wasSentByApi, true);
  assert.equal(sent.chat.wa_contactName, "");
  const phone = toPayload(s, { key: { remoteJid: "5517999990000@s.whatsapp.net", fromMe: true, id: "P1" }, message: { conversation: "Bom dia" } });
  assert.equal(phone.message.wasSentByApi, false);
});

test("audio, LID chats, groups and system messages", () => {
  const audio = toPayload(s, { key: { remoteJid: "123456789@lid", remoteJidAlt: "5517911112222@s.whatsapp.net", fromMe: false, id: "A2" }, message: { audioMessage: { ptt: true } } });
  assert.equal(audio.message.mediaType, "ptt");
  assert.equal(audio.message.type, "media");
  assert.equal(audio.chat.phone, "5517911112222");
  assert.equal(toPayload(s, { key: { remoteJid: "120363@g.us", id: "G" }, message: { conversation: "x" } }), null);
  assert.equal(toPayload(s, { key: { remoteJid: "status@broadcast", id: "S" }, message: { conversation: "x" } }), null);
  assert.equal(toPayload(s, { key: { remoteJid: "5517@s.whatsapp.net", id: "P" }, message: { protocolMessage: {} } }), null);
  const reaction = toPayload(s, { key: { remoteJid: "5517999990000@s.whatsapp.net", id: "R" }, message: { reactionMessage: { text: "👍" } } });
  assert.equal(reaction.message.type, "reaction");
});
