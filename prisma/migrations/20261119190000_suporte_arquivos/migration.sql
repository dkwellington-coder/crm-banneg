-- Suporte: the files (audio, photo, PDF, video) of each message, kept on the WhatsApp server with a copy in Google Drive
ALTER TABLE "SupportMessage" ADD COLUMN "mediaMime" TEXT,
ADD COLUMN "mediaName" TEXT,
ADD COLUMN "mediaSize" INTEGER,
ADD COLUMN "mediaStatus" TEXT,
ADD COLUMN "mediaError" TEXT,
ADD COLUMN "driveFileId" TEXT,
ADD COLUMN "driveTries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "driveError" TEXT;

CREATE INDEX "SupportMessage_mediaStatus_driveFileId_idx" ON "SupportMessage"("mediaStatus", "driveFileId");
