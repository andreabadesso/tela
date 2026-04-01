import 'dotenv/config';
import { config } from './config/env.js';
import { DatabaseService } from './services/database.js';
import { GitSync } from './services/git.js';
import { TelegramService } from './services/telegram.js';
import { createVaultTools } from './tools/vault.js';
import { CtoAgent } from './agent.js';
import { AgentService } from './services/agent-service.js';
import { JobRegistry } from './jobs/registry.js';
import { registerCommands } from './handlers/index.js';
import { startApiServer } from './api/server.js';
import { ResponseCollector } from './services/response-collector.js';
import { createRuntimeRegistry } from './runtime/index.js';

// Optional Phase 2-4 services
import { GoogleAuthService } from './services/google-auth.js';
import { CalendarService } from './services/calendar.js';
import { GmailService } from './services/gmail.js';
import { ShipLensService } from './services/shiplens.js';
import { JiraService } from './services/jira.js';
import { GitHubService } from './services/github.js';
import { TranscriptProcessor } from './services/transcript.js';
import { KnowledgeIngestionService } from './services/knowledge.js';
import { VectorStoreService } from './services/vector-store.js';
import { PatternLearningService } from './services/pattern-learning.js';
import { NotificationFilterService } from './services/notification-filter.js';
import { NotificationManager } from './notifications/manager.js';
import { Orchestrator } from './orchestrator/index.js';
// import { createAuth } from './auth/index.js';
import { EncryptionService } from './services/encryption.js';
import { McpGateway } from './services/mcp-gateway.js';
import { KnowledgeManager } from './knowledge/manager.js';
import { ObsidianAdapter } from './knowledge/adapters/obsidian.js';
import type { ObsidianAdapterConfig } from './knowledge/adapters/obsidian.js';

async function main() {
  console.log(`[${new Date().toISOString()}] Starting CTO Agent...`);

  // Core services
  const db = new DatabaseService();
  const gitSync = new GitSync(config.vaultPath, !!config.gitRemoteUrl);
  const vaultTools = createVaultTools(config.vaultPath);

  // Telegram is optional (web-only mode if not configured)
  let telegram: TelegramService | null = null;
  if (config.telegramBotToken && config.telegramChatId) {
    telegram = new TelegramService(config.telegramBotToken, config.telegramChatId);
  } else {
    console.log('[init] Telegram not configured — running in web-only mode.');
  }

  const agent = new CtoAgent(vaultTools, telegram!, gitSync, db);
  const encryption = new EncryptionService();
  const mcpGateway = new McpGateway(db, encryption);

  // Knowledge Manager — register adapters from DB
  const knowledgeManager = new KnowledgeManager();

  // Auto-create default knowledge source if VAULT_PATH is set and none exist
  if (config.vaultPath && config.vaultPath !== './vault') {
    const existingSources = db.getKnowledgeSources();
    if (existingSources.length === 0) {
      db.createKnowledgeSource({
        id: 'default-vault',
        name: 'Vault',
        type: 'obsidian',
        config: JSON.stringify({
          vaultPath: config.vaultPath,
          gitRemoteUrl: config.gitRemoteUrl,
        } satisfies Partial<ObsidianAdapterConfig>),
        status: 'connected',
        doc_count: 0,
        last_sync_at: null,
        error_message: null,
      });
      console.log('[init] Auto-created default knowledge source from VAULT_PATH.');
    }
  }

  // Register all knowledge sources from DB
  for (const source of db.getKnowledgeSources()) {
    if (source.type === 'obsidian') {
      try {
        const sourceConfig: ObsidianAdapterConfig = JSON.parse(source.config || '{}');
        const collectionName = `knowledge-${source.id}`;
        let vs: VectorStoreService | undefined;
        if (config.chromaUrl) {
          vs = new VectorStoreService(sourceConfig.vaultPath || config.vaultPath, collectionName);
          try {
            await vs.initialize();
          } catch {
            vs = undefined;
          }
        }
        const adapter = new ObsidianAdapter(source.id, sourceConfig, vs);
        knowledgeManager.register(adapter);
      } catch (err) {
        console.error(`[init] Failed to register knowledge source ${source.id}:`, err);
      }
    }
  }
  console.log(`[init] Knowledge manager: ${knowledgeManager.getAll().length} source(s) registered.`);

  const agentService = new AgentService(db, vaultTools, gitSync, mcpGateway, knowledgeManager);
  console.log('[init] MCP Governance Gateway ready.');

  // Phase 2: Google services (optional)
  let googleAuth: GoogleAuthService | null = null;
  let calendar: CalendarService | null = null;
  let gmail: GmailService | null = null;

  if (config.googleClientId && config.googleClientSecret) {
    googleAuth = new GoogleAuthService(config.googleClientId, config.googleClientSecret, config.googleRedirectUri, db);
    if (googleAuth.isAuthenticated()) {
      calendar = new CalendarService(googleAuth);
      gmail = new GmailService(googleAuth);
      console.log('[init] Google Calendar + Gmail connected.');
    } else {
      console.log(`[init] Google not authenticated. Visit: ${googleAuth.getAuthUrl()}`);
    }
  }

  // Phase 2: Transcript processor
  let transcriptProcessor: TranscriptProcessor | null = null;
  if (config.transcriptDir) {
    transcriptProcessor = new TranscriptProcessor(config.transcriptDir, agent, vaultTools, gitSync, telegram!, calendar);
    transcriptProcessor.start();
    console.log(`[init] Transcript watcher started: ${config.transcriptDir}`);
  }

  // Phase 2: Knowledge ingestion
  const knowledge = new KnowledgeIngestionService(agent, vaultTools, gitSync, telegram!);

  // Phase 3: ShipLens (optional)
  let shiplens: ShipLensService | null = null;
  if (config.shiplensUrl || config.shiplensCommand) {
    shiplens = new ShipLensService();
    try {
      await shiplens.connect();
      console.log('[init] ShipLens connected.');
    } catch (err) {
      console.error('[init] ShipLens connection failed:', err);
      shiplens = null;
    }
  }

  // Phase 3: Jira (optional)
  let jira: JiraService | null = null;
  if (config.jiraBaseUrl && config.jiraApiToken) {
    jira = new JiraService();
    console.log('[init] Jira connected.');
  }

  // Phase 3: GitHub (optional)
  let github: GitHubService | null = null;
  if (config.githubToken && config.githubOrg) {
    github = new GitHubService();
    console.log('[init] GitHub connected.');
  }

  // Phase 4: Vector store — per-source indexing handled by knowledge adapters
  // Legacy single-collection fallback only if no knowledge sources registered
  let vectorStore: VectorStoreService | null = null;
  if (config.chromaUrl && knowledgeManager.getAll().length === 0) {
    vectorStore = new VectorStoreService(config.vaultPath);
    try {
      await vectorStore.initialize();
      if (vectorStore.isAvailable()) {
        console.log('[init] ChromaDB connected (legacy). Starting initial index...');
        const count = await vectorStore.indexAll();
        console.log(`[init] Indexed ${count} vault files.`);
      }
    } catch (err) {
      console.error('[init] ChromaDB failed:', err);
      vectorStore = null;
    }
  } else if (config.chromaUrl) {
    console.log('[init] ChromaDB: per-source collections managed by knowledge adapters.');
  }

  // Phase 4: Pattern learning + notification filtering
  const patterns = new PatternLearningService(db);
  const notificationFilter = new NotificationFilterService(db);

  // Notification manager (pluggable channels)
  const notificationManager = new NotificationManager(db);
  await notificationManager.loadFromDb();
  console.log(`[init] Notification manager loaded (${notificationManager.size} channels).`);

  // Agent runtime registry
  const runtimeRegistry = createRuntimeRegistry(agentService, db, {
    image: config.agentDockerImage,
    hostCallbackPort: config.port,
  });

  // Multi-agent orchestrator
  const orchestrator = new Orchestrator(db, agentService, runtimeRegistry);
  console.log('[init] Orchestrator ready.');

  // Register commands + message handler (only if Telegram is configured)
  const jobRegistry = new JobRegistry(telegram!, db);
  const eodCollector = new ResponseCollector();

  if (telegram) {
    registerCommands({ telegram, agent, vault: vaultTools, gitSync, shiplens, jira, github });

    telegram.onMessage(async (text, messageId) => {
      if (eodCollector.isCollecting) {
        eodCollector.addMessage(text);
        return;
      }

      if (text.match(/^https?:\/\//)) {
        try {
          const result = await knowledge.ingest(text, messageId);
          await telegram.send(
            `📥 ${result.summary}\n\n📁 ${result.savedTo || 'Não salvo'}`,
            { replyTo: messageId },
          );
          return;
        } catch (err) {
          console.error('[ingest] Failed:', err);
        }
      }

      const response = await agent.process({ text, source: 'telegram' });
      const replyText = markdownToTelegramHtml(response.text.trim()) || '🤔 Não consegui gerar uma resposta. Tenta de novo?';
      await telegram.send(replyText, { parseMode: 'HTML', replyTo: messageId });
      patterns.logInteraction({ topic: text.slice(0, 50), queryType: 'question' });
    });

    telegram.start();
  }

  // Phase 6: Authentication — using built-in email/password (better-auth disabled due to module conflict)
  const auth = undefined;
  console.log('[init] Auth: email/password via built-in routes.');

  jobRegistry.start();
  const apiServer = startApiServer({ agent, agentService, orchestrator, db, gitSync, jobRegistry, knowledgeManager, notificationManager, auth, mcpGateway, runtimeRegistry });

  console.log(`[${new Date().toISOString()}] CTO Agent running. All phases loaded.`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    jobRegistry.stop();
    telegram?.stop();
    transcriptProcessor?.stop();
    await shiplens?.disconnect();
    await mcpGateway?.disconnectAll();
    await gitSync.flush();
    apiServer.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** Convert leftover markdown to Telegram-safe HTML */
function markdownToTelegramHtml(text: string): string {
  return text
    // Code blocks: ```lang\n...\n``` → <pre>...</pre>
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre>$1</pre>')
    // Inline code: `...` → <code>...</code>
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold: **...** or __...__ → <b>...</b>
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    // Italic: *...* or _..._ → <i>...</i>
    .replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>')
    .replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>')
    // Links: [text](url) → <a href="url">text</a>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
