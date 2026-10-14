-- AlterTable
ALTER TABLE "Pipeline" ADD COLUMN     "aiGoal" TEXT,
ADD COLUMN     "aiQuestions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "nextPipelineId" TEXT,
ADD COLUMN     "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_slug_key" ON "Pipeline"("slug");
