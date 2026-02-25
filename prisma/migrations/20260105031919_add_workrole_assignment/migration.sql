/*
  Warnings:

  - You are about to drop the column `paidBy` on the `OtAssignment` table. All the data in the column will be lost.
  - You are about to alter the column `amountDefault` on the `OtAssignment` table. The data in that column could be lost. The data in that column will be cast from `Integer` to `Decimal(10,2)`.
  - You are about to alter the column `amountOverride` on the `OtAssignment` table. The data in that column could be lost. The data in that column will be cast from `Integer` to `Decimal(10,2)`.
  - You are about to drop the column `createdBy` on the `OtEvent` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `OtAssignment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `createdById` to the `OtEvent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `OtEvent` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `taskCodes` on the `OtEvent` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `updatedAt` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "WorkRole" AS ENUM ('JUNIOR_MARSHAL', 'SENIOR_MARSHAL', 'JUNIOR_EMCEE', 'SENIOR_EMCEE');

-- DropForeignKey
ALTER TABLE "OtAssignment" DROP CONSTRAINT "OtAssignment_otEventId_fkey";

-- AlterTable
ALTER TABLE "OtAssignment" DROP COLUMN "paidBy",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "paidById" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "workRole" "WorkRole" NOT NULL DEFAULT 'JUNIOR_MARSHAL',
ALTER COLUMN "amountDefault" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "amountOverride" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "OtEvent" DROP COLUMN "createdBy",
ADD COLUMN     "createdById" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
DROP COLUMN "taskCodes",
ADD COLUMN     "taskCodes" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "defaultWorkRole" "WorkRole" NOT NULL DEFAULT 'JUNIOR_MARSHAL',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AddForeignKey
ALTER TABLE "OtEvent" ADD CONSTRAINT "OtEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtAssignment" ADD CONSTRAINT "OtAssignment_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtAssignment" ADD CONSTRAINT "OtAssignment_otEventId_fkey" FOREIGN KEY ("otEventId") REFERENCES "OtEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
