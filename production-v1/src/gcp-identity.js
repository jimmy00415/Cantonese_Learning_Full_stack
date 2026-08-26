const projectId = 'motion-expert-hk-ltd-webpage';
const projectNumber = '582852715831';
const serviceAccount = (id) => `${id}@${projectId}.iam.gserviceaccount.com`;

export const GCP_IDENTITY = Object.freeze({
  projectId,
  projectNumber,
  organizationId: '797368190621',
  billingAccountId: '01F9FD-24EA9B-A9232C',
  region: 'asia-east2',
  speechRegion: 'asia-southeast1',
  service: 'hkbuddy-v1-api',
  repository: 'hkbuddy-v1',
  bucket: 'hkbuddy-v1-582852715831-media',
  cloudSqlInstance: 'hkbuddy-v1-pg',
  database: 'hkbuddy_v1',
  network: 'hkbuddy-v1-vpc',
  subnet: 'hkbuddy-v1-ae2-run',
  psaRange: 'hkbuddy-v1-google-services',
  serviceAccounts: Object.freeze({
    runtime: serviceAccount('hkbuddy-v1-runtime'),
    build: serviceAccount('hkbuddy-v1-build'),
    migrator: serviceAccount('hkbuddy-v1-migrator'),
    deployer: serviceAccount('hkbuddy-v1-deployer'),
    acceptance: serviceAccount('hkbuddy-v1-acceptance'),
  }),
  secrets: Object.freeze({
    dbAppUrl: 'hkbuddy-v1-db-app-url',
    dbMigratorUrl: 'hkbuddy-v1-db-migrator-url',
    session: 'hkbuddy-v1-session-secret',
    bootstrap: 'hkbuddy-v1-db-bootstrap-state',
    legacy: 'hkbuddy-v1-legacy-inventory',
    dependencies: 'hkbuddy-v1-dependency-acceptance',
    llm: 'hkbuddy-v1-llm-smoke',
    asr: 'hkbuddy-v1-asr-smoke',
    tts: 'hkbuddy-v1-tts-smoke',
    ios: 'hkbuddy-v1-ios-voice-acceptance',
  }),
  jobs: Object.freeze({
    migration: 'hkbuddy-v1-migrate',
    dependencies: 'hkbuddy-v1-dependency-acceptance',
    llm: 'hkbuddy-v1-llm-smoke',
    asr: 'hkbuddy-v1-asr-smoke',
    tts: 'hkbuddy-v1-tts-smoke',
  }),
});
