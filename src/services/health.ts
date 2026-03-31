import http from 'node:http';
import type { DatabaseService } from './database.js';
import type { GitSync } from './git.js';
import type { JobRegistry } from '../jobs/registry.js';

const PORT = parseInt(process.env.HEALTH_PORT || '3000', 10);
const startTime = Date.now();

export function startHealthServer(
  db: DatabaseService,
  gitSync: GitSync,
  jobRegistry: JobRegistry,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const health = {
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        lastGitSync: gitSync.lastSyncTime?.toISOString() ?? null,
        lastJobRuns: db.getLastJobRuns(),
        conversationsToday: db.getConversationCountToday(),
        errors24h: db.getErrorCount24h(),
        jobs: jobRegistry.list().map((j) => ({ name: j.name, enabled: j.enabled })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}`);
  });

  return server;
}
