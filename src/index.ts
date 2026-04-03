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
import { TranscriptProcessor } from './knowledge/transcript.js';
import { KnowledgeIngestionService } from './knowledge/ingestion-service.js';
import { VectorStoreService } from './agent/vector-store.js';
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

  if (config.googleClientId && config.googleClientSecret) {
    googleAuth = new GoogleAuthService(config.googleClientId, config.googleClientSecret, config.googleRedirectUri, db);
    if (googleAuth.isAuthenticated()) {
      calendar = new CalendarService(googleAuth);
      console.log('[init] Google Calendar connected.');
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

  // Agent runtime registry
  const devContainerConfig = config.devContainerEnabled ? {
    image: config.devContainerImage,
    hostCallbackPort: config.port,
    defaultMemoryMb: config.devContainerMemoryMb,
    defaultTimeoutMs: config.devContainerTimeoutMs,
  } : undefined;

  const runtimeRegistry = createRuntimeRegistry(agentService, db, {
    image: config.agentDockerImage,
    hostCallbackPort: config.port,
  }, devContainerConfig);

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
    await mcpGateway?.disconnectAll();
    await gitSync.flush();
    apiServer.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Suppress unused variable warning for optionally-wired auth service
  void googleAuth;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
