-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "jobDescription" TEXT,
ADD COLUMN     "workMode" TEXT NOT NULL DEFAULT 'ONSITE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "homeLocation" TEXT;
