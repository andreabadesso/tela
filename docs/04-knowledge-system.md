# Knowledge System

Tela's knowledge system gives agents access to company knowledge through a unified interface. Multiple knowledge sources (Obsidian vaults, filesystems, with Notion and Confluence planned) are indexed in a vector store and searchable through common tools.

## Architecture

```
Agent
  │
  ├─ search_knowledge(query) ──→ Knowledge Manager ──→ Vector Store (ChromaDB)
  │                                    │                     │
  │                                    ├─ Obsidian Adapter   ├─ Semantic search
  │                                    ├─ Filesystem Adapter │   across all sources
  │                                    ├─ Notion Adapter     │
  │                                    └─ Confluence Adapter  │
  │                                                          │
  └─ read_document(path) ──→ Direct read via adapter ────────┘
```

## Knowledge Adapters

All adapters implement the `KnowledgeAdapter` interface (`src/knowledge/types.ts`):

```typescript
interface KnowledgeAdapter {
  id: string
  name: string
  type: 'obsidian' | 'filesystem' | 'notion' | 'confluence'
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  read(path: string): Promise<Document>
  list(directory?: string): Promise<DocumentMeta[]>
  sync(): Promise<SyncResult>  // Index/re-index to vector store
}
```

### Obsidian Adapter

Primary knowledge adapter, designed for Obsidian vaults:

- **Path scoping** — Reads from configured vault path, prevents traversal
- **Frontmatter parsing** — Extracts YAML frontmatter (tags, aliases, dates)
- **Wikilink resolution** — Understands `[[Note Name]]` links
- **Tag extraction** — Indexes `#tags` for filtered search
- **Git sync** — Pull before reads, batch commits after writes

### Filesystem Adapter

Generic directory reader for non-Obsidian sources:

- **Recursive scanning** — Walks directory tree for `.md`, `.txt`, `.pdf` files
- **Ripgrep search** — Falls back to `rg` for full-text search when vector store unavailable
- **Path-based filtering** — Configurable include/exclude patterns

## Vector Store (ChromaDB)

ChromaDB provides semantic search across all knowledge sources.

### Indexing Pipeline

1. **Read** — Adapter reads all documents from source
2. **Chunk** — Heading-aware chunker splits content into ~500-token segments with overlap
3. **Embed** — Generate embeddings (all-MiniLM-L6-v2 via `@chroma-core/default-embed`)
4. **Store** — Upsert to ChromaDB with metadata (source, path, title, tags, last modified)

### Heading-Aware Chunking

The chunker (`src/knowledge/chunker.ts`) respects Markdown structure:

- Splits at heading boundaries (`#`, `##`, `###`)
- Preserves heading hierarchy in chunk metadata
- Maintains minimum chunk size (avoids tiny fragments)
- Adds overlap between chunks for context continuity

### Incremental Sync

After initial index, subsequent syncs are incremental:

1. Identify changed files (via git diff or file modification time)
2. Re-index only changed files
3. Delete embeddings for removed files
4. Detect renames via git diff (delete old, index new)

### Collections

Each knowledge source gets its own ChromaDB collection. Cross-source search queries all collections and merges results by relevance score.

### Degradation

If ChromaDB is unavailable, the system degrades gracefully:
- Falls back to ripgrep-based keyword search
- Circuit breaker prevents repeated failed connections
- Logs degradation for monitoring

## Agent Tools

Agents access knowledge through these MCP tools:

| Tool | Description |
|------|-------------|
| `search_knowledge` | Semantic search across all sources. Returns ranked results with source attribution, relevance scores, and matched snippets. |
| `read_document` | Read a specific document by path. Routed to the appropriate adapter based on source. |

### Source Attribution

Every search result includes:
- Source identifier (which knowledge source)
- Document path
- Relevance score
- Matched snippet with context
- Metadata (tags, dates, author if available)

## Knowledge Ingestion

Beyond structured sources, Tela can ingest ad-hoc content (task 018):

### Supported Content Types

| Type | Parser | Storage |
|------|--------|---------|
| URL | article-extractor | Knowledge/Articles/ |
| PDF | pdf-parse | Knowledge/Articles/ |
| Image | Claude vision | Inbox/ |
| YouTube | yt-dlp (transcript) | Knowledge/Articles/ |
| Tweet/X | HTTP + parse | Inbox/ |
| Text | Direct | Inbox/ or daily note |
| Audio/Voice | Whisper API | Inbox/ |

### Ingestion Pipeline

1. **Detect** content type
2. **Parse** using appropriate parser
3. **Process with Claude** — Summarize, extract insights, correlate with existing vault content
4. **Classify** — reference, idea, action item, or ignore
5. **Store** in appropriate vault location
6. **Index** in ChromaDB
7. **Notify** user with summary, connections found, and storage location

### Enhanced Ingestion with Semantic Search (Task 030)

When ingesting new content, semantic search finds related existing notes:
- Surfaces thematic connections between new and existing content
- Identifies contradictions and reinforcements
- Highlights knowledge gaps
- Suggests backlinks (not auto-applied)

## Knowledge Policies

Access to knowledge sources is governed by RBAC policies (separate from MCP policies):

| Field | Description |
|-------|-------------|
| `principal_type` | `role`, `team`, or `user` |
| `principal_id` | ID of the principal |
| `knowledge_source_id` | Which source |
| `access_level` | `read`, `write`, or `none` |

The knowledge manager checks these policies before returning search results, filtering out sources the user doesn't have access to.

## Vault Tools

The original vault tools (`src/tools/vault.ts`) provide direct file operations:

| Tool | Description |
|------|-------------|
| `read_note` | Read a note by path |
| `write_note` | Create or overwrite a note |
| `edit_note` | Modify specific sections |
| `append_to_note` | Add content to end |
| `prepend_to_note` | Add content to beginning |
| `search_vault` | Ripgrep full-text search |
| `list_notes` | Directory listing |
| `get_tasks` | Parse `- [ ]` and `- [x]` markers |
| `get_daily_note` | Read/create daily note from template |

All vault tools enforce path traversal protection via `VAULT_PATH` validation. Write operations are batched into git commits (5-second debounce) via the `WriteBatch` system.
