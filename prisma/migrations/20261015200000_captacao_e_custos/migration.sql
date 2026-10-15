-- CreateTable
CREATE TABLE "AdSpend" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "accountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "metaLeads" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdSpend_date_idx" ON "AdSpend"("date");

-- AlterTable
ALTER TABLE "WhatsAppTemplate" ADD COLUMN     "headerUrl" TEXT;
