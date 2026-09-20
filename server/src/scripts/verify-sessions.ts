import { sessionStore, type PkceStateData, type UserSessionData } from '../lib/sessionStore.js';
import { redis } from '../lib/redis.js';

async function main() {
  console.log('🧪 Starting Redis Ephemeral Store & Session Lifecycle Verification...');

  const testState = 'test_oauth_state_' + Date.now();
  const testSessionId = 'test_session_id_' + Date.now();

  // 1. Test PKCE State Storage
  const pkceData: PkceStateData = {
    codeVerifier: 'verifier_abc_123_high_entropy_secret_string',
    iss: 'https://launch.smarthealthit.org/v/r4/fhir',
    launch: 'sample_launch_token_999',
    createdAt: Date.now(),
  };

  console.log(`1️⃣ Saving PKCE state: key=pkce:${testState} (TTL: 300s)...`);
  await sessionStore.savePkceState(testState, pkceData, 300);

  // 2. Test Atomic One-Time Consumption
  console.log(`2️⃣ Consuming PKCE state via GETDEL...`);
  const consumedFirst = await sessionStore.consumePkceState(testState);

  if (!consumedFirst || consumedFirst.codeVerifier !== pkceData.codeVerifier) {
    throw new Error('FAILED: First PKCE consume did not return expected data!');
  }
  console.log('✅ First consume succeeded: code_verifier matches.');

  console.log(`3️⃣ Attempting second consume on same state (Replay Test)...`);
  const consumedSecond = await sessionStore.consumePkceState(testState);

  if (consumedSecond !== null) {
    throw new Error('FAILED: Second PKCE consume should have returned null (replay vulnerability)!');
  }
  console.log('✅ Second consume returned null: Single-use / anti-replay pattern verified.');

  // 3. Test Session Creation
  const sessionData: UserSessionData = {
    accessToken: 'test_fhir_access_token_super_secret_xyz',
    tokenType: 'Bearer',
    expiresIn: 3600,
    patientId: 'Patient/10293',
    fhirUser: 'Practitioner/doc-42',
    scope: 'launch openid fhirUser patient/*.read',
    idToken: 'sample_id_token',
    createdAt: Date.now(),
  };

  console.log(`4️⃣ Creating user session: key=session:${testSessionId} (TTL: 60s)...`);
  await sessionStore.createSession(testSessionId, sessionData, 60);

  // 4. Test Session Retrieval
  console.log(`5️⃣ Retrieving session data...`);
  const fetchedSession = await sessionStore.getSession(testSessionId);

  if (!fetchedSession || fetchedSession.accessToken !== sessionData.accessToken) {
    throw new Error('FAILED: Session data retrieved does not match created session!');
  }
  console.log(`✅ Session retrieved: patientId=${fetchedSession.patientId}, fhirUser=${fetchedSession.fhirUser}`);

  // 5. Test Session Touch (TTL update)
  const initialTtl = await sessionStore.getSessionTtl(testSessionId);
  console.log(`ℹ️ Initial remaining TTL: ${initialTtl}s`);

  console.log(`6️⃣ Touching session to extend TTL to 180s...`);
  const touched = await sessionStore.touchSession(testSessionId, 180);
  if (!touched) {
    throw new Error('FAILED: touchSession returned false!');
  }

  const updatedTtl = await sessionStore.getSessionTtl(testSessionId);
  console.log(`✅ Updated remaining TTL: ${updatedTtl}s (successfully extended)`);
  if (updatedTtl <= initialTtl) {
    throw new Error('FAILED: TTL was not extended properly!');
  }

  // 6. Test Session Destruction
  console.log(`7️⃣ Destroying session...`);
  const destroyed = await sessionStore.destroySession(testSessionId);
  if (!destroyed) {
    throw new Error('FAILED: destroySession returned false!');
  }

  const afterDestroy = await sessionStore.getSession(testSessionId);
  if (afterDestroy !== null) {
    throw new Error('FAILED: Session still exists after destroy!');
  }
  console.log('✅ Session destroyed: Subsequent getSession returned null.');

  console.log('🎉 All Redis session store assertions passed successfully!');
}

main()
  .catch((err) => {
    console.error('❌ Verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await redis.quit();
  });
