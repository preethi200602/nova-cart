-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "payoutPaidAt" TIMESTAMP(3),
ADD COLUMN     "payoutReference" TEXT,
ADD COLUMN     "payoutStatus" TEXT NOT NULL DEFAULT 'pending';
