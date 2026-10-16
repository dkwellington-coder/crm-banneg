-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mediaKind" TEXT,
ADD COLUMN     "mediaType" TEXT;

-- CreateTable
CREATE TABLE "MessageMedia" (
    "messageId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "MessageMedia_pkey" PRIMARY KEY ("messageId")
);

-- AddForeignKey
ALTER TABLE "MessageMedia" ADD CONSTRAINT "MessageMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

