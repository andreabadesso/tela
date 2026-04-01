function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const config = {
  // Core (Telegram optional for web-only mode)
  telegramBotToken: optionalEnv('TELEGRAM_BOT_TOKEN') ?? '',
  telegramChatId: optionalEnv('TELEGRAM_CHAT_ID') ?? '',
  vaultPath: optionalEnv('VAULT_PATH') ?? './vault',
  gitRemoteUrl: optionalEnv('GIT_REMOTE_URL'),
  timezone: process.env.TZ || 'America/Sao_Paulo',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Phase 5 — API (optional)
  apiToken: optionalEnv('API_TOKEN'),
  encryptionKey: optionalEnv('ENCRYPTION_KEY'),
  port: parseInt(process.env.PORT || '3000', 10),

  // Phase 2 — Google (optional)
  googleClientId: optionalEnv('GOOGLE_CLIENT_ID'),
  googleClientSecret: optionalEnv('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: optionalEnv('GOOGLE_REDIRECT_URI') || 'http://localhost:3000/oauth/callback',

  // Phase 2 — Knowledge ingestion (optional)
  transcriptDir: optionalEnv('TRANSCRIPT_DIR') || '/data/transcripts',
  openaiApiKey: optionalEnv('OPENAI_API_KEY'), // for Whisper

  // Phase 3 — ShipLens (optional)
  shiplensTransport: (optionalEnv('SHIPLENS_TRANSPORT') || 'http') as 'stdio' | 'http',
  shiplensUrl: optionalEnv('SHIPLENS_URL'),
  shiplensCommand: optionalEnv('SHIPLENS_COMMAND'),
  shiplensApiKey: optionalEnv('SHIPLENS_API_KEY'),

  // Phase 3 — Jira (optional)
  jiraBaseUrl: optionalEnv('JIRA_BASE_URL'),
  jiraApiToken: optionalEnv('JIRA_API_TOKEN'),
  jiraUserEmail: optionalEnv('JIRA_USER_EMAIL'),
  jiraSquadMapping: optionalEnv('JIRA_SQUAD_MAPPING'), // JSON string

  // Phase 3 — GitHub (optional)
  githubToken: optionalEnv('GITHUB_TOKEN'),
  githubOrg: optionalEnv('GITHUB_ORG'),
  githubRepos: optionalEnv('GITHUB_REPOS'), // comma-separated

  // Phase 4 — ChromaDB (optional)
  chromaUrl: optionalEnv('CHROMA_URL') || 'http://localhost:8000',

  // Phase 6 — Google SSO (optional, separate from Calendar integration)
  googleSsoClientId: optionalEnv('GOOGLE_SSO_CLIENT_ID'),
  googleSsoClientSecret: optionalEnv('GOOGLE_SSO_CLIENT_SECRET'),

  // Phase 8 — Agent Runtime (optional)
  agentRuntime: (optionalEnv('AGENT_RUNTIME') || 'agent-os') as 'in-process' | 'docker' | 'agent-os' | 'remote',
  agentDockerImage: optionalEnv('AGENT_DOCKER_IMAGE') || 'tela-agent-worker:latest',
  agentDefaultTimeout: parseInt(process.env.AGENT_DEFAULT_TIMEOUT || '300000', 10),

  // Phase 9 — Agent Memory (optional)
  agentMemoryEnabled: (optionalEnv('AGENT_MEMORY_ENABLED') ?? 'true') === 'true',
};
