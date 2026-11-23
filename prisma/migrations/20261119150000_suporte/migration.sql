-- CreateTable
CREATE TABLE "SupportAttendant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "workDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "workStart" TEXT NOT NULL DEFAULT '08:00',
    "workEnd" TEXT NOT NULL DEFAULT '18:00',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAttendant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportNumber" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "server" TEXT,
    "token" TEXT NOT NULL,
    "webhookKey" TEXT NOT NULL,
    "status" TEXT,
    "statusAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportChat" (
    "id" TEXT NOT NULL,
    "numberId" TEXT NOT NULL,
    "waChatId" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBody" TEXT,
    "lastFromMe" BOOLEAN NOT NULL DEFAULT false,
    "waitingSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT,
    "via" TEXT NOT NULL DEFAULT 'phone',
    "author" TEXT,
    "attendantId" TEXT,
    "externalId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_SupportAttendantToSupportNumber" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_SupportAttendantToSupportNumber_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportAttendant_userId_key" ON "SupportAttendant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportNumber_webhookKey_key" ON "SupportNumber"("webhookKey");

-- CreateIndex
CREATE INDEX "SupportChat_lastMessageAt_idx" ON "SupportChat"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportChat_numberId_waChatId_key" ON "SupportChat"("numberId", "waChatId");

-- CreateIndex
CREATE INDEX "SupportMessage_chatId_createdAt_idx" ON "SupportMessage"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportMessage_createdAt_idx" ON "SupportMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_chatId_externalId_key" ON "SupportMessage"("chatId", "externalId");

-- CreateIndex
CREATE INDEX "_SupportAttendantToSupportNumber_B_index" ON "_SupportAttendantToSupportNumber"("B");

-- AddForeignKey
ALTER TABLE "SupportChat" ADD CONSTRAINT "SupportChat_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "SupportNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "SupportChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_attendantId_fkey" FOREIGN KEY ("attendantId") REFERENCES "SupportAttendant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SupportAttendantToSupportNumber" ADD CONSTRAINT "_SupportAttendantToSupportNumber_A_fkey" FOREIGN KEY ("A") REFERENCES "SupportAttendant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SupportAttendantToSupportNumber" ADD CONSTRAINT "_SupportAttendantToSupportNumber_B_fkey" FOREIGN KEY ("B") REFERENCES "SupportNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

