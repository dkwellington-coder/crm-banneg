// node --test: what the gateway posts to the CRM, in the shape Uazapi uses (the CRM's parser is tested in tests/suporte.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.ADMIN_TOKEN = "x".repeat(32);
const { toPayload, groupList, SEND_ONLY_SYNC } = await import("./server.mjs");
const { proto } = await import("baileys");
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

test("files carry what the CRM needs to show them; stickers do not", () => {
  const pdf = toPayload(s, {
    key: { remoteJid: "5517999990000@s.whatsapp.net", fromMe: false, id: "D1" },
    message: { documentMessage: { mimetype: "application/pdf", fileName: "boleto.pdf", fileLength: 2048, caption: "segue" } },
  });
  assert.deepEqual(pdf.message.media, { mimetype: "application/pdf", fileName: "boleto.pdf", size: 2048, seconds: 0 });
  assert.equal(pdf.message.text, "segue");
  const audio = toPayload(s, { key: { remoteJid: "5517999990000@s.whatsapp.net", id: "A3" }, message: { audioMessage: { ptt: true, mimetype: "audio/ogg; codecs=opus", seconds: 12 } } });
  assert.equal(audio.message.media.mimetype, "audio/ogg");
  assert.equal(audio.message.media.seconds, 12);
  const sticker = toPayload(s, { key: { remoteJid: "5517999990000@s.whatsapp.net", id: "ST" }, message: { stickerMessage: { mimetype: "image/webp" } } });
  assert.equal(sticker.message.media, undefined);
});

test("history: name from the address book, phone from the LID list, marked as history", () => {
  const history = { names: new Map([["123@lid", "Joana Cliente"]]), lids: new Map([["123@lid", "5517933334444@s.whatsapp.net"]]) };
  const mine = toPayload(s, { key: { remoteJid: "123@lid", fromMe: true, id: "H1" }, messageTimestamp: 1763000000, message: { conversation: "Bom dia, Joana" } }, history);
  assert.equal(mine.chat.wa_contactName, "Joana Cliente");
  assert.equal(mine.chat.phone, "5517933334444");
  assert.equal(mine.message.history, true);
});

test("group list in Uazapi's shape: only groups, with their names", () => {
  assert.deepEqual(
    groupList({
      "120363001@g.us": { id: "120363001@g.us", subject: "Leads expansao" },
      "120363002@g.us": { id: "120363002@g.us", subject: "" },
      x: { id: "5517999990000@s.whatsapp.net", subject: "not a group" },
    }),
    [
      { JID: "120363001@g.us", Name: "Leads expansao" },
      { JID: "120363002@g.us", Name: "" },
    ],
  );
});

test("secretary's number: a group message carries the group, who wrote, who was mentioned and what it answers", async () => {
  const { allowedGroup } = await import("./server.mjs");
  const sec = { sentByApi: new Set(), groupsOnly: true, groups: ["120363000@g.us"] };
  assert.equal(allowedGroup(sec, "120363000@g.us"), true);
  assert.equal(allowedGroup(sec, "999@g.us"), false);
  assert.equal(allowedGroup(sec, "5517999990000@s.whatsapp.net"), false);
  const m = {
    key: { remoteJid: "120363000@g.us", participant: "777@lid", participantAlt: "5517981600088@s.whatsapp.net", fromMe: false, id: "G1" },
    pushName: "Wellington",
    messageTimestamp: 1764150000,
    message: {
      extendedTextMessage: {
        text: "@5517911110000 marca reunião amanhã 10h",
        contextInfo: { mentionedJid: ["5517911110000@s.whatsapp.net"], stanzaId: "Q1", participant: "5517911110000@s.whatsapp.net", quotedMessage: { conversation: "Qual horário?" } },
      },
    },
  };
  const p = toPayload(sec, m, undefined, { group: true });
  assert.equal(p.message.isGroup, true);
  assert.equal(p.chat.wa_chatid, "120363000@g.us");
  assert.equal(p.message.sender_pn, "5517981600088@s.whatsapp.net");
  assert.equal(p.message.sender_lid, "777");
  assert.equal(p.message.senderName, "Wellington");
  assert.deepEqual(p.message.mentioned, ["5517911110000"]);
  assert.deepEqual(p.message.quoted, { id: "Q1", text: "Qual horário?", sender: "5517911110000" });
  // A group never goes out from a support number
  assert.equal(toPayload(s, m), null);
  const { secretaryPayload } = await import("./server.mjs");
  const dm = { key: { remoteJid: "5517999990000@s.whatsapp.net", id: "P9" }, message: { conversation: "x" } };
  assert.equal(secretaryPayload(sec, dm), null);
  assert.equal(secretaryPayload({ ...sec, privates: true }, dm).message.isGroup, false);
  assert.equal(secretaryPayload(sec, { ...m, key: { ...m.key, remoteJid: "999@g.us" } }), null);
  assert.equal(secretaryPayload(sec, m).message.isGroup, true);
});

test("a send-only number takes only the first sync WhatsApp needs, never the conversations", () => {
  const T = proto.HistorySync.HistorySyncType;
  assert.ok(SEND_ONLY_SYNC.has(T.INITIAL_BOOTSTRAP));
  for (const t of [T.FULL, T.RECENT, T.ON_DEMAND]) assert.equal(SEND_ONLY_SYNC.has(t), false);
});
