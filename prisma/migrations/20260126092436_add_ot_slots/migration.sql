/*
  Warnings:

  - You are about to alter the column `amountDefault` on the `OtAssignment` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Integer`.
  - You are about to alter the column `amountOverride` on the `OtAssignment` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Integer`.
  - A unique constraint covering the columns `[otEventId,userId,otSlotId]` on the table `OtAssignment` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "OtAssignment_otEventId_userId_key";

-- AlterTable
ALTER TABLE "OtAssignment" ADD COLUMN     "otSlotId" TEXT,
ALTER COLUMN "amountDefault" SET DATA TYPE INTEGER,
ALTER COLUMN "amountOverride" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "OtEvent" ALTER COLUMN "taskCodes" SET DATA TYPE TEXT;

-- CreateTable
CREATE TABLE "OtSlot" (
    "id" TEXT NOT NULL,
    "otEventId" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "taskCodes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OtSlot_otEventId_idx" ON "OtSlot"("otEventId");

-- CreateIndex
CREATE INDEX "OtSlot_otEventId_index_idx" ON "OtSlot"("otEventId", "index");

-- CreateIndex
CREATE INDEX "OtAssignment_userId_idx" ON "OtAssignment"("userId");

-- CreateIndex
CREATE INDEX "OtAssignment_otEventId_idx" ON "OtAssignment"("otEventId");

-- CreateIndex
CREATE INDEX "OtAssignment_otSlotId_idx" ON "OtAssignment"("otSlotId");

-- CreateIndex
CREATE INDEX "OtAssignment_status_idx" ON "OtAssignment"("status");

-- CreateIndex
CREATE INDEX "OtAssignment_workRole_idx" ON "OtAssignment"("workRole");

-- CreateIndex
CREATE UNIQUE INDEX "OtAssignment_otEventId_userId_otSlotId_key" ON "OtAssignment"("otEventId", "userId", "otSlotId");

-- CreateIndex
CREATE INDEX "OtEvent_date_idx" ON "OtEvent"("date");

-- CreateIndex
CREATE INDEX "OtEvent_createdById_idx" ON "OtEvent"("createdById");

-- AddForeignKey
ALTER TABLE "OtSlot" ADD CONSTRAINT "OtSlot_otEventId_fkey" FOREIGN KEY ("otEventId") REFERENCES "OtEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtAssignment" ADD CONSTRAINT "OtAssignment_otSlotId_fkey" FOREIGN KEY ("otSlotId") REFERENCES "OtSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
