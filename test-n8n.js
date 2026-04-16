// Run on VPS: node test-n8n.js
// Shows exactly why the n8n API is failing
require('dotenv').config();

const N8N_URL     = process.env.N8N_URL     || 'https://n8n.effipm.cloud';
const N8N_KEY     = process.env.N8N_KEY     || '';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'TCTwgK1Apdy4oULj';

console.log('─'.repeat(60));
console.log('N8N_URL    :', N8N_URL);
console.log('N8N_KEY    :', N8N_KEY ? N8N_KEY.slice(0, 20) + '...' : '*** MISSING ***');
console.log('WORKFLOW_ID:', WORKFLOW_ID);
console.log('─'.repeat(60));

async function test(label, url, opts = {}) {
  process.stdout.write(`\n[${label}] ${url.replace(N8N_KEY, '<KEY>')}\n`);
  try {
    const r = await fetch(url, opts);
    const body = await r.text();
    console.log(`  Status : ${r.status} ${r.statusText}`);
    console.log(`  Body   : ${body.slice(0, 300)}`);
    return r.status;
  } catch(e) {
    console.log(`  ERROR  : ${e.message}`);
    return null;
  }
}

(async () => {
  // 1. Header auth
  await test('header auth', `${N8N_URL}/api/v1/executions?workflowId=${WORKFLOW_ID}&limit=1`, {
    headers: { 'X-N8N-API-KEY': N8N_KEY }
  });

  // 2. Query param auth
  await test('query param', `${N8N_URL}/api/v1/executions?workflowId=${WORKFLOW_ID}&limit=1&apiKey=${encodeURIComponent(N8N_KEY)}`);

  // 3. No auth (to confirm 401 is auth-related not network)
  await test('no auth', `${N8N_URL}/api/v1/executions?workflowId=${WORKFLOW_ID}&limit=1`);

  // 4. Webhook (should work regardless of API key)
  await test('webhook', `${N8N_URL}/webhook/market-briefing-trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });

  console.log('\n' + '─'.repeat(60));
  console.log('Done. Share the output above to diagnose the issue.');
  console.log('─'.repeat(60));
})();
