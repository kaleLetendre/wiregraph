// Thin CLI over the wiregraph MCP server, so an agent without the MCP
// registered can still call its tools:
//   node scripts/mcp-cli.mjs <tool> '<json-args>'
// e.g. node scripts/mcp-cli.mjs trace_callers '{"name":"parse_request","repo":"api-server"}'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [, , tool, argsJson] = process.argv;
if (!tool) { console.error('usage: mcp-cli.mjs <tool> <json-args>'); process.exit(2); }
let args = {};
try { args = argsJson ? JSON.parse(argsJson) : {}; }
catch (e) { console.error('bad json args: ' + e.message); process.exit(2); }

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(here, '..', 'src', 'mcp', 'server.js')],
  env: { ...process.env },
});
const client = new Client({ name: 'cli', version: '0' });
await client.connect(transport);
const r = await client.callTool({ name: tool, arguments: args });
console.log(r.content.map((c) => c.text).join('\n'));
await client.close();
process.exit(0);
