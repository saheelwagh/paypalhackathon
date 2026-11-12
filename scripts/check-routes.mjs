// HTTP smoke checks only; these do not replace interactive browser journeys.
const base = process.env.APP_URL || 'http://127.0.0.1:3000';
const parsed = new URL(base);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Route checks are restricted to a local preview.');
const routes = ['/', '/login', '/overview', '/records', '/clients', '/clients/demo_acme_client', '/conversations', '/conversations/demo_discovery', '/proposals', '/proposals/demo_launch_proposal', '/projects', '/projects/demo_acme', '/changes', '/changes/demo_animation', '/billing', '/sandbox', '/sandbox/new', '/sandbox/projects', '/sandbox/projects/new', '/collections', '/workspace', '/activity', '/settings', '/portal/demo_acme', '/not-a-route'];
const results = await Promise.allSettled(routes.map(async route => { const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(20000) }); if (response.status !== 200) throw new Error(`${route}: HTTP ${response.status}`); const body = await response.text(); if (!body.includes('Freelancer workspace')) throw new Error(`${route}: application shell missing`); return route; }));
let failures = 0;
for (let i = 0; i < results.length; i++) { const result = results[i]; if (result.status === 'rejected') { failures++; console.error(`${routes[i]}: ${result.reason}`); } }
const response = await fetch(new URL('/api/capabilities', base));
const capability = await response.json();
if (!response.ok || capability.mode !== 'demo' || capability.connectedEnabled !== false || !Array.isArray(capability.capabilities)) { failures++; console.error('Capability endpoint contract failed'); }
console.log(`${results.length - failures}/${results.length} page routes responded with the application shell; capability endpoint ${response.status}. Interactive behavior requires browser QA.`);
process.exitCode = failures ? 1 : 0;
