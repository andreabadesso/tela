// ─── Shared OAuth infrastructure ────────────────────────────────
// Used by both connections.ts (admin/company-level) and
// user-connections.ts (user-scoped tokens).

export interface OAuthProvider {
  type: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  jira: {
    type: 'jira',
    name: 'Jira',
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: ['read:jira-work', 'read:jira-user', 'write:jira-work'],
    clientIdEnv: 'JIRA_CLIENT_ID',
    clientSecretEnv: 'JIRA_CLIENT_SECRET',
  },
  github: {
    type: 'github',
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org'],
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
  google: {
    type: 'google',
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
};

export function getBaseUrl(c: { req: { header: (name: string) => string | undefined; url: string } }): string {
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

export function callbackPage(success: boolean, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Connection ${success ? 'Success' : 'Failed'}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0b; color: #fafafa; }
    .card { text-align: center; padding: 2rem; border-radius: 8px; border: 1px solid #27272a; background: #18181b; max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 1rem; }
    .message { color: #a1a1aa; margin-top: 0.5rem; }
    .close-hint { color: #52525b; margin-top: 1rem; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '&#10003;' : '&#10007;'}</div>
    <h2>${success ? 'Connected!' : 'Connection Failed'}</h2>
    <p class="message">${message}</p>
    <p class="close-hint">This window will close automatically...</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'oauth-callback', success: ${success} }, '*');
    }
    setTimeout(() => window.close(), 2000);
  </script>
</body>
</html>`;
}
