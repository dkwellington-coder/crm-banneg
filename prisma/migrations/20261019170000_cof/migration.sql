-- CreateTable
CREATE TABLE "FranchiseDocument" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "data" BYTEA NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FranchiseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CofDelivery" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "documents" JSONB NOT NULL,
    "attached" BOOLEAN NOT NULL DEFAULT true,
    "messageId" TEXT,
    "smtpResponse" TEXT,
    "raw" BYTEA,
    "sentBy" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmIp" TEXT,
    "confirmAgent" TEXT,

    CONSTRAINT "CofDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CofDelivery_token_key" ON "CofDelivery"("token");

-- CreateIndex
CREATE INDEX "CofDelivery_leadId_sentAt_idx" ON "CofDelivery"("leadId", "sentAt");

-- AddForeignKey
ALTER TABLE "CofDelivery" ADD CONSTRAINT "CofDelivery_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
