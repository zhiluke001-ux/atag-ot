-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Grade" AS ENUM ('JUNIOR', 'SENIOR');

-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('UNPAID', 'PAID');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "grade" "Grade" NOT NULL DEFAULT 'JUNIOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtEvent" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "project" TEXT NOT NULL,
    "taskNotes" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "taskCodes" TEXT NOT NULL,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "OtEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtAssignment" (
    "id" TEXT NOT NULL,
    "otEventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PayStatus" NOT NULL DEFAULT 'UNPAID',
    "amountDefault" INTEGER NOT NULL,
    "amountOverride" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,

    CONSTRAINT "OtAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OtAssignment_otEventId_userId_key" ON "OtAssignment"("otEventId", "userId");

-- AddForeignKey
ALTER TABLE "OtAssignment" ADD CONSTRAINT "OtAssignment_otEventId_fkey" FOREIGN KEY ("otEventId") REFERENCES "OtEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtAssignment" ADD CONSTRAINT "OtAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
