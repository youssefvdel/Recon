// Dev-only probe: discover the OP.GG MCP tool schemas at runtime.
// All request bodies are built with JSON.stringify (never hand-quoted shell JSON).
//
//   bun scripts/opgg-mcp-probe.ts [toolName]
export {};

const ENDPOINT = 'https://mcp-api.op.gg/mcp';

type Json = Record<string, unknown>;

async function rpc(method: string, params?: unknown, id: number | string = 1): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Streamable HTTP may answer plain JSON or SSE (`data: {...}` lines).
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const payload = t.slice(5).trim();
        if (payload && payload !== '[DONE]') return JSON.parse(payload) as unknown;
      }
    }
    throw new Error(`SSE reply with no data frame: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as unknown;
}

function resultOf(reply: unknown): unknown {
  const r = (reply ?? {}) as Json;
  if (r.error) throw new Error(`RPC error: ${JSON.stringify(r.error).slice(0, 500)}`);
  return r.result;
}

const init = (await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'recon-probe', version: '0.0.0' },
}, 0)) as Json;
console.log('server:', JSON.stringify((init as Json).result ?? init).slice(0, 300));

// Initialized notification (no reply expected).
await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
}).catch(() => {});

const toolsReply = await rpc('tools/list', {}, 2);
const tools = ((resultOf(toolsReply) ?? {}) as Json).tools as Array<Json>;
if (!Array.isArray(tools)) {
  console.log('unexpected tools/list shape:', JSON.stringify(toolsReply).slice(0, 500));
  process.exit(1);
}
console.log(`\n${tools.length} tools:`);
for (const t of tools) console.log(` - ${String(t.name)}: ${String(t.description ?? '').slice(0, 120)}`);

const only = process.argv[2];
const wanted = tools.filter(
  (t) => !only || String(t.name) === only || String(t.name).toLowerCase().includes('valorant')
);
console.log('\n--- schemas ---');
for (const t of wanted) {
  console.log(`\n## ${String(t.name)}`);
  console.log(JSON.stringify(t.inputSchema ?? t.input_schema ?? {}, null, 1).slice(0, 3000));
}
