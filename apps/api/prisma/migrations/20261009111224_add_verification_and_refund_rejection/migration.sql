-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "refundRejectionReason" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "verificationToken" TEXT,
ADD COLUMN     "verificationTokenExpiry" TIMESTAMP(3);
