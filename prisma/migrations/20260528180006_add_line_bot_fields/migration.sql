-- AlterTable
ALTER TABLE "User" ADD COLUMN "lineUserId" TEXT,
ADD COLUMN "lineLinkCode" TEXT;

-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN "interviewDate" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_lineUserId_key" ON "User"("lineUserId");
