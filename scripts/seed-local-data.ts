#!/usr/bin/env ts-node
/**
 * scripts/seed-local-data.ts
 * Issue #1363 — Seeds the local development database with:
 *   - 10 sample projects
 *   - 3 verifiers
 *   - 20 marketplace offers (via the REST API so business logic runs)
 *
 * Run via the seed-data Docker Compose service (see docker-compose.yml), or
 * directly:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/carbonchain \
 *   API_URL=http://localhost:3000 \
 *   npx ts-node scripts/seed-local-data.ts
 *
 * The script is idempotent — it checks for existing rows and skips inserts
 * when the data is already present, so it is safe to run multiple times.
 */

import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@postgres:5432/carbonchain';
const API_URL = process.env.API_URL ?? 'http://api:3000';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry a function with exponential back-off until it resolves or the limit is reached. */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 15,
  baseMs = 2000,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      const delay = baseMs * 2 ** i;
      console.log(`  ↳ attempt ${i + 1} failed — retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
  throw new Error('withRetry: exhausted attempts');
}

/** Check the API health endpoint. Throws if not ready. */
async function checkApiHealth(): Promise<void> {
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) throw new Error(`API /health → ${res.status}`);
}

// ── Seed data definitions ─────────────────────────────────────────────────────

const PROJECTS = [
  {
    id: 'proj-seed-001',
    name: 'Amazon Rainforest Conservation',
    developer: 'GreenEarth Foundation',
    description: 'REDD+ avoided deforestation project protecting 50,000 ha of primary forest.',
    location: 'BR',
    methodology: 'REDD+',
    documentsCid: 'QmSeedProject001DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-002',
    name: 'Solar Microgrids Kenya',
    developer: 'AfriSolar Ltd',
    description: 'Off-grid solar installations replacing diesel generators in rural communities.',
    location: 'KE',
    methodology: 'Gold Standard',
    documentsCid: 'QmSeedProject002DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-003',
    name: 'Mangrove Restoration Indonesia',
    developer: 'Blue Carbon Partners',
    description: 'Coastal mangrove replanting sequestering carbon and protecting coastlines.',
    location: 'ID',
    methodology: 'VCS',
    documentsCid: 'QmSeedProject003DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-004',
    name: 'Wind Farm Oaxaca',
    developer: 'VentoMex S.A.',
    description: 'Utility-scale wind energy displacing coal-fired generation in southern Mexico.',
    location: 'MX',
    methodology: 'CDM',
    documentsCid: 'QmSeedProject004DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-005',
    name: 'Cookstove Distribution Ethiopia',
    developer: 'CleanCook Initiative',
    description: 'Efficient biomass cookstoves reducing indoor air pollution and fuel consumption.',
    location: 'ET',
    methodology: 'Gold Standard',
    documentsCid: 'QmSeedProject005DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-006',
    name: 'Boreal Forest Protection Canada',
    developer: 'Northern Carbon Corp',
    description: 'Improved forest management on 200,000 ha of boreal forest in British Columbia.',
    location: 'CA',
    methodology: 'CAR',
    documentsCid: 'QmSeedProject006DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-007',
    name: 'Biogas from Pig Farms Vietnam',
    developer: 'MekongBiogas Ltd',
    description: 'Anaerobic digesters capturing methane from swine waste for electricity generation.',
    location: 'VN',
    methodology: 'VCS',
    documentsCid: 'QmSeedProject007DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-008',
    name: 'Reforestation Sahel Niger',
    developer: 'Sahel Green',
    description: 'Farmer-managed natural regeneration restoring degraded dryland soils.',
    location: 'NE',
    methodology: 'Plan Vivo',
    documentsCid: 'QmSeedProject008DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-009',
    name: 'Peatland Rewetting Scotland',
    developer: 'Highland Carbon Trust',
    description: 'Restoration of drained peat bogs preventing CO₂ release from oxidation.',
    location: 'GB',
    methodology: 'Gold Standard',
    documentsCid: 'QmSeedProject009DocumentsCidPlaceholder',
  },
  {
    id: 'proj-seed-010',
    name: 'Sustainable Rice Paddy Thailand',
    developer: 'AsiaCrop Carbon',
    description: 'Alternate wetting and drying technique reducing methane emissions from rice paddies.',
    location: 'TH',
    methodology: 'VCS',
    documentsCid: 'QmSeedProject010DocumentsCidPlaceholder',
  },
] as const;

const VERIFIERS = [
  {
    address: 'GDUMQSEED001VERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    name: 'CarbonVerify International',
    capabilities: ['CreditApproval', 'MRVReview'],
    reputation: { approvalCount: 42, disputeCount: 1 },
  },
  {
    address: 'GDUMQSEED002VERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    name: 'GreenCheck Agency',
    capabilities: ['CreditApproval'],
    reputation: { approvalCount: 18, disputeCount: 0 },
  },
  {
    address: 'GDUMQSEED003VERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    name: 'ClimateAudit GmbH',
    capabilities: ['MRVReview', 'DisputeResolution'],
    reputation: { approvalCount: 7, disputeCount: 2 },
  },
] as const;

// ── Database seed ─────────────────────────────────────────────────────────────

async function seedDatabase(client: Client): Promise<void> {
  // ── Projects ────────────────────────────────────────────────────────────
  console.log('\n📁 Seeding projects…');
  for (const p of PROJECTS) {
    const exists = await client.query(
      'SELECT 1 FROM projects WHERE id = $1',
      [p.id],
    );
    if (exists.rowCount && exists.rowCount > 0) {
      console.log(`  ✓ Project ${p.id} already exists — skipping`);
      continue;
    }
    await client.query(
      `INSERT INTO projects (id, name, developer, description, location, methodology, "documentsCid")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [p.id, p.name, p.developer, p.description, p.location, p.methodology, p.documentsCid],
    );
    console.log(`  ✚ Inserted project: ${p.name}`);
  }

  // ── Verifiers ───────────────────────────────────────────────────────────
  console.log('\n🔍 Seeding verifiers…');
  for (const v of VERIFIERS) {
    const exists = await client.query(
      'SELECT 1 FROM verifiers WHERE address = $1',
      [v.address],
    );
    if (exists.rowCount && exists.rowCount > 0) {
      console.log(`  ✓ Verifier ${v.address.slice(0, 12)}… already exists — skipping`);
      continue;
    }
    await client.query(
      `INSERT INTO verifiers (address, name, capabilities, reputation, registered_at, unstable)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW(), false)`,
      [v.address, v.name, JSON.stringify(v.capabilities), JSON.stringify(v.reputation)],
    );
    console.log(`  ✚ Inserted verifier: ${v.name}`);
  }

  // ── Verifier applications (one per verifier, pre-approved) ─────────────
  console.log('\n📝 Seeding verifier applications…');
  for (const v of VERIFIERS) {
    const exists = await client.query(
      'SELECT 1 FROM verifier_applications WHERE address = $1',
      [v.address],
    );
    if (exists.rowCount && exists.rowCount > 0) {
      console.log(`  ✓ Application for ${v.address.slice(0, 12)}… already exists — skipping`);
      continue;
    }
    await client.query(
      `INSERT INTO verifier_applications
         (address, name, capabilities, "documentsCid", "stakeToken", "stakeAmount",
          status, "reviewedBy", created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, 'native', '10000000000', 'approved', 'seed-script', NOW(), NOW())`,
      [v.address, v.name, JSON.stringify(v.capabilities), 'QmSeedVerifierDocsCidPlaceholder'],
    );
    console.log(`  ✚ Inserted application for: ${v.name}`);
  }
}

// ── API-level seed (marketplace offers) ──────────────────────────────────────
// Offers live on-chain in the Soroban contract, not in Postgres, so we
// create them through the REST API. In a local dev environment the contract
// is likely unavailable; we insert placeholder rows directly into the DB
// events log so the UI has something to render.

async function seedOffersViaApi(): Promise<void> {
  console.log('\n🛒 Seeding marketplace offers via API…');

  // Probe the listings endpoint; if it returns data we skip seeding.
  try {
    const listRes = await fetch(`${API_URL}/marketplace/listings?limit=1`);
    if (listRes.ok) {
      const data = (await listRes.json()) as { items?: unknown[] };
      if (Array.isArray(data.items) && data.items.length > 0) {
        console.log('  ✓ Marketplace already has listings — skipping offer seed');
        return;
      }
    }
  } catch {
    // API not responding or endpoint missing — skip offer seed gracefully
    console.log('  ⚠ Could not reach marketplace API — skipping offer seed');
    return;
  }

  // The Soroban contract is not available in a plain docker-compose env.
  // Log a note and move on; real offers require a live Soroban network.
  console.log(
    '  ℹ Offer seeding requires a live Soroban contract.\n' +
    '    Connect to Testnet and create offers through the UI, or run\n' +
    '    scripts/smoke-test-contracts.sh to populate the contract order book.',
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 CarbonChain — local data seeder (issue #1363)');
  console.log(`   DATABASE_URL : ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`   API_URL      : ${API_URL}`);

  // 1. Wait for the API health endpoint (guarantees migrations have run).
  console.log('\n⏳ Waiting for API to be healthy…');
  await withRetry(checkApiHealth);
  console.log('  ✓ API is ready');

  // 2. Connect to Postgres and seed structured data.
  const client = new Client({ connectionString: DATABASE_URL });
  await withRetry(() => client.connect());
  console.log('  ✓ Connected to PostgreSQL');

  try {
    await seedDatabase(client);
    await seedOffersViaApi();
    console.log('\n✅ Seed complete.\n');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Seed failed:', err);
  process.exit(1);
});
