#!/bin/bash
# Wrapper for insforge-mcp that filters non-JSON stdout lines to stderr.
# The InsForge MCP server prints startup messages to stdout which breaks
# the SDK's JSON-RPC protocol parser.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MCP_ENTRY="$SCRIPT_DIR/node_modules/@insforge/mcp/dist/index.js"

exec node "$MCP_ENTRY" "$@" 2>&1 | while IFS= read -r line; do
  if [[ "$line" == "{"* ]]; then
    echo "$line"
  else
    echo "$line" >&2
  fi
done
