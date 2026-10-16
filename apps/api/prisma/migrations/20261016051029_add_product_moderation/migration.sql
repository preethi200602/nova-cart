-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderationReason" TEXT;
