#!/usr/bin/env node
/**
 * Wrapper for insforge-mcp that filters non-JSON stdout lines to stderr.
 * The InsForge MCP server prints startup banners to stdout which breaks
 * the MCP JSON-RPC protocol.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpEntry = join(__dirname, '..', 'node_modules', '@insforge', 'mcp', 'dist', 'index.js');

const child = spawn('node', [mcpEntry, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

// Forward stdin from SDK to child
process.stdin.pipe(child.stdin);

// Filter stdout: only pass JSON lines, redirect rest to stderr
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.startsWith('{')) {
    process.stdout.write(line + '\n');
  } else {
    process.stderr.write(line + '\n');
  }
});

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
