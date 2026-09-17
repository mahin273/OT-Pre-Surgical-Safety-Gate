-- CreateEnum
CREATE TYPE "GateStatus" AS ENUM ('PASS', 'BLOCK', 'MANUAL_REVIEW');

-- CreateTable
CREATE TABLE "ChecklistRun" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "procedureCpt" TEXT NOT NULL,
    "diagnosisSnomed" TEXT NOT NULL,
    "status" "GateStatus" NOT NULL,
    "checks" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminologyCache" (
    "id" TEXT NOT NULL,
    "codeSystem" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminologyCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChecklistRun_patientId_idx" ON "ChecklistRun"("patientId");

-- CreateIndex
CREATE INDEX "ChecklistRun_createdAt_idx" ON "ChecklistRun"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_runId_idx" ON "AuditEvent"("runId");

-- CreateIndex
CREATE INDEX "AuditEvent_actor_idx" ON "AuditEvent"("actor");

-- CreateIndex
CREATE INDEX "AuditEvent_timestamp_idx" ON "AuditEvent"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "TerminologyCache_codeSystem_code_key" ON "TerminologyCache"("codeSystem", "code");

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChecklistRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
