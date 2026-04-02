import 'dotenv/config';
import { config } from './config/env.js';
import { DatabaseService } from './core/database.js';
import { GitSync } from './core/git.js';
import { ChannelGateway } from './channels/gateway.js';
import { createVaultTools } from './tools/vault.js';
import { AgentService } from './agent/service.js';
import { JobRegistry } from './jobs/registry.js';
import { startApiServer } from './api/server.js';
import { createRuntimeRegistry } from './runtime/index.js';

// Optional Phase 2-4 services
import { GoogleAuthService } from './integrations/google-auth.js';
import { CalendarService } from './integrations/calendar.js';
import { GmailService } from './integrations/gmail.js';
import { ShipLensService } from './integrations/shiplens.js';
import { JiraService } from './integrations/jira.js';
import { GitHubService } from './integrations/github.js';
import { TranscriptProcessor } from './services/transcript.js';
import { KnowledgeIngestionService } from './services/knowledge.js';
import { VectorStoreService } from './agent/vector-store.js';
import { PatternLearningService } from './services/pattern-learning.js';
import { NotificationFilterService } from './services/notification-filter.js';
import { NotificationManager } from './notifications/manager.js';
import { Orchestrator } from './orchestrator/index.js';
// import { createAuth } from './auth/index.js';
import { EncryptionService } from './core/encryption.js';
import { McpGateway } from './agent/mcp-gateway.js';
import { KnowledgeManager } from './knowledge/manager.js';
import { ObsidianAdapter } from './knowledge/adapters/obsidian.js';
import type { ObsidianAdapterConfig } from './knowledge/adapters/obsidian.js';

async function main() {
  console.log(`[${new Date().toISOString()}] Starting Tela...`);

  // Core services
  const db = new DatabaseService();
  const gitSync = new GitSync(config.vaultPath, !!config.gitRemoteUrl);
  const vaultTools = createVaultTools(config.vaultPath);
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

  // Notification manager (pluggable channels) — loaded before transcript/knowledge
  const notificationManager = new NotificationManager(db);
  await notificationManager.loadFromDb();
  console.log(`[init] Notification manager loaded (${notificationManager.size} channels).`);

  // Resolve the default agent ID (first enabled agent)
  const defaultAgentId = db.getAgents().find((a) => a.enabled)?.id ?? '';

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
    transcriptProcessor = new TranscriptProcessor(config.transcriptDir, agentService, defaultAgentId, vaultTools, gitSync, notificationManager, calendar);
    transcriptProcessor.start();
    console.log(`[init] Transcript watcher started: ${config.transcriptDir}`);
  }

  // Phase 2: Knowledge ingestion
  const knowledge = new KnowledgeIngestionService(agentService, defaultAgentId, vaultTools, gitSync, notificationManager);

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

  // Agent runtime registry
  const runtimeRegistry = createRuntimeRegistry(agentService, db, {
    image: config.agentDockerImage,
    hostCallbackPort: config.port,
  });

  // Multi-agent orchestrator
  const orchestrator = new Orchestrator(db, agentService, runtimeRegistry);
  console.log('[init] Orchestrator ready.');

  // Communication channel gateway — single entry point for all inbound/outbound
  const channelGateway = new ChannelGateway(db, orchestrator);
  channelGateway.setKnowledgeIngestion(knowledge);
  await channelGateway.startAll();
  console.log(`[init] Channel gateway started (${channelGateway.size} channels).`);

  // Phase 6: Authentication — using built-in email/password (better-auth disabled due to module conflict)
  const auth = undefined;
  console.log('[init] Auth: email/password via built-in routes.');

  // Job registry — wire schedule tools into agents & load persisted schedules
  const jobRegistry = new JobRegistry(db);
  jobRegistry.setChannelGateway(channelGateway);
  agentService.setScheduleDeps(jobRegistry);
  jobRegistry.onOneShotComplete = (jobName: string) => {
    const scheduleId = jobName.replace('schedule:', '');
    db.updateScheduleStatus(scheduleId, 'completed');
    db.updateSchedule(scheduleId, { enabled: 0 });
    console.log(`[jobs] One-shot schedule ${scheduleId} completed.`);
  };
  await jobRegistry.loadSchedulesFromDb(db, agentService);
  jobRegistry.start();

  const apiServer = startApiServer({ agentService, orchestrator, db, gitSync, jobRegistry, knowledgeManager, notificationManager, auth, mcpGateway, runtimeRegistry, channelGateway });

  console.log(`[${new Date().toISOString()}] Tela running. All phases loaded.`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    jobRegistry.stop();
    await channelGateway.stopAll();
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

  // Suppress unused variable warnings for optionally-wired services
  void gmail; void github; void jira; void vectorStore; void notificationFilter; void patterns; void googleAuth;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
