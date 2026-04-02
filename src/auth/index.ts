import Database from 'better-sqlite3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createAuth(dbPath: string): Promise<any> {
  const { betterAuth } = await import('better-auth');
  const db = new Database(dbPath);

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GOOGLE_SSO_CLIENT_ID && process.env.GOOGLE_SSO_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_SSO_CLIENT_ID,
      clientSecret: process.env.GOOGLE_SSO_CLIENT_SECRET,
    };
  }

  return betterAuth({
    database: db,
    basePath: '/api/auth',
    baseURL: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    emailAndPassword: {
      enabled: true,
    },
    socialProviders,
    user: {
      modelName: 'users',
      fields: {
        email: 'email',
        emailVerified: 'email_verified',
        name: 'name',
        image: 'image',
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        token: 'token',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
    },
    account: {
      modelName: 'accounts',
      fields: {
        userId: 'user_id',
        providerId: 'provider',
        accountId: 'provider_account_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        scope: 'scope',
        password: 'password',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: {
        identifier: 'identifier',
        value: 'value',
        expiresAt: 'expires_at',
      },
    },
  });
}

export type BetterAuthInstance = Awaited<ReturnType<typeof createAuth>>;
