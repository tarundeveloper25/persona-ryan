import * as fs from 'fs';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: npx tsx scripts/validate-team-agent.ts assets/team-agent.json');
  process.exit(1);
}

const raw = fs.readFileSync(filePath, 'utf8');
const parsed = JSON.parse(raw) as Record<string, unknown>;

if (typeof parsed.appId !== 'string' || !parsed.appId.trim()) {
  throw new Error('appId is required');
}

if (typeof parsed.endpointId !== 'string' || !parsed.endpointId.trim()) {
  throw new Error('endpointId is required');
}

if (!parsed.endpoint || typeof parsed.endpoint !== 'object') {
  throw new Error('endpoint object is required');
}

const endpoint = parsed.endpoint as Record<string, unknown>;

if (endpoint.id !== parsed.endpointId) {
  throw new Error('endpoint.id must match endpointId');
}

for (const field of ['name', 'slug', 'method']) {
  if (typeof endpoint[field] !== 'string' || !(endpoint[field] as string).trim()) {
    throw new Error(`endpoint.${field} is required`);
  }
}

console.log('team-agent.json is valid');
