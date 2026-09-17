import { prisma, GateStatus, Prisma, type CheckResult } from '../lib/prisma.js';

async function main() {
  console.log('🧪 Starting PostgreSQL & Prisma Schema Verification...');

  // 1. Clean up any existing test records
  await prisma.auditEvent.deleteMany({
    where: { actor: 'Practitioner/test-surgeon-01' },
  });
  await prisma.checklistRun.deleteMany({
    where: { patientId: 'Patient/test-pat-999' },
  });
  await prisma.terminologyCache.deleteMany({
    where: { codeSystem: 'http://snomed.info/sct', code: 'TEST-235919008' },
  });

  // 2. Test ChecklistRun Creation
  const testChecks: CheckResult[] = [
    { name: 'diagnosis_procedure_match', passed: true, detail: 'SNOMED 235919008 matches CPT 47562' },
    { name: 'consent', passed: true, detail: 'Signed consent found for CPT 47562' },
    { name: 'labs', passed: true, detail: 'Platelets: 180 (min 50), INR: 1.1 (max 1.5), PT: 12.5 (max 14.0)' },
    { name: 'allergy', passed: true, detail: 'No allergy conflict with Cefazolin' },
  ];

  const createdRun = await prisma.checklistRun.create({
    data: {
      patientId: 'Patient/test-pat-999',
      procedureCpt: '47562',
      diagnosisSnomed: '235919008',
      status: GateStatus.PASS,
      checks: testChecks as unknown as Prisma.InputJsonValue,
      createdBy: 'Practitioner/test-surgeon-01',
    },
  });

  console.log(`✅ ChecklistRun created: id=${createdRun.id}, status=${createdRun.status}`);

  // 3. Test AuditEvent Creation with relation
  const createdAudit = await prisma.auditEvent.create({
    data: {
      runId: createdRun.id,
      actor: 'Practitioner/test-surgeon-01',
      action: 'GATE_EVALUATION',
      outcome: 'PASS',
      detail: { checksEvaluated: 4, passedCount: 4 },
    },
  });

  console.log(`✅ AuditEvent created: id=${createdAudit.id}, runId=${createdAudit.runId}`);

  // 4. Test TerminologyCache Creation
  const createdTerm = await prisma.terminologyCache.create({
    data: {
      codeSystem: 'http://snomed.info/sct',
      code: 'TEST-235919008',
      display: 'Calculus of gallbladder with acute cholecystitis',
    },
  });

  console.log(`✅ TerminologyCache created: ${createdTerm.codeSystem}#${createdTerm.code}`);

  // 5. Test Unique Constraint on TerminologyCache
  let duplicateRejected = false;
  try {
    await prisma.terminologyCache.create({
      data: {
        codeSystem: 'http://snomed.info/sct',
        code: 'TEST-235919008',
        display: 'Duplicate attempt',
      },
    });
  } catch (err: any) {
    if (err.code === 'P2002') {
      duplicateRejected = true;
      console.log('✅ Unique constraint enforced: Duplicate (codeSystem, code) rejected with P2002.');
    } else {
      throw err;
    }
  }

  if (!duplicateRejected) {
    throw new Error('FAILED: TerminologyCache unique constraint did not reject duplicate code!');
  }

  // 6. Test Relational Query (ChecklistRun with AuditEvents)
  const fetched = await prisma.checklistRun.findUnique({
    where: { id: createdRun.id },
    include: { auditEvents: true },
  });

  if (!fetched || fetched.auditEvents.length !== 1) {
    throw new Error('FAILED: Failed to fetch ChecklistRun with related AuditEvents!');
  }
  console.log(`✅ Relational query successful: Retrieved run with ${fetched.auditEvents.length} audit event(s)`);

  // 7. Cleanup
  await prisma.checklistRun.delete({ where: { id: createdRun.id } });
  await prisma.terminologyCache.delete({ where: { id: createdTerm.id } });
  console.log('🧹 Test data cleaned up successfully.');

  console.log('🎉 All PostgreSQL & Prisma schema assertions passed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Verification failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
