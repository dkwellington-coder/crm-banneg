-- Secretária (Wellington, 2026-11-26): her WhatsApp messages, the tasks she keeps and chases, and the e-mails she writes
-- CreateTable
CREATE TABLE "SecretaryMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "isGroup" BOOLEAN NOT NULL DEFAULT true,
    "externalId" TEXT,
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "byApi" BOOLEAN NOT NULL DEFAULT false,
    "senderPhone" TEXT,
    "senderName" TEXT,
    "body" TEXT NOT NULL,
    "kind" TEXT,
    "mediaStatus" TEXT,
    "quotedText" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretaryMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretaryTask" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'tarefa',
    "assignee" TEXT,
    "assigneePhone" TEXT,
    "dueAt" TIMESTAMP(3),
    "remindAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "nextNudgeAt" TIMESTAMP(3),
    "nudges" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'aberta',
    "createdBy" TEXT,
    "chatId" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretaryTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretaryEmail" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "cc" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'rascunho',
    "createdBy" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretaryEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecretaryMessage_chatId_at_idx" ON "SecretaryMessage"("chatId", "at");

-- CreateIndex
CREATE INDEX "SecretaryMessage_handledAt_idx" ON "SecretaryMessage"("handledAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecretaryMessage_chatId_externalId_key" ON "SecretaryMessage"("chatId", "externalId");

-- CreateIndex
CREATE INDEX "SecretaryTask_status_nextNudgeAt_idx" ON "SecretaryTask"("status", "nextNudgeAt");

-- CreateIndex
CREATE INDEX "SecretaryTask_status_remindAt_idx" ON "SecretaryTask"("status", "remindAt");

-- CreateIndex
CREATE INDEX "SecretaryEmail_status_idx" ON "SecretaryEmail"("status");

