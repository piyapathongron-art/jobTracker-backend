-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "salaryCurrency" TEXT NOT NULL DEFAULT 'THB',
ADD COLUMN     "salaryPeriod" TEXT NOT NULL DEFAULT 'MONTHLY';
