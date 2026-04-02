# Auth, RBAC & Governance

Tela provides enterprise-grade identity management, role-based access control, and policy-driven governance.

## Authentication

### Methods

| Method | Use Case | Implementation |
|--------|----------|----------------|
| **Google SSO** | Primary login for employees | better-auth with Google provider |
| **API Keys** | Programmatic access | Prefix visible, hash stored, per-user |
| **Legacy Token** | Migration/super-admin fallback | `API_TOKEN` env var, full access |
| **Dev Mode** | Local development | Empty `API_TOKEN` = no auth required |

### Auth Middleware Pipeline

The middleware (`src/api/middleware.ts`) tries each method in order:

1. **Session cookie** — Check for valid better-auth session
2. **Bearer token (API key)** — Match prefix, verify hash
3. **Legacy token** — Compare against `API_TOKEN` env var
4. **Dev mode** — If `API_TOKEN` is empty, grant access with synthetic admin user

First match wins. If none match, return 401.

### User Provisioning

- **First login** — Auto-provisioned with `viewer` role
- **Domain-based** — `allowed_email_domains` in settings restricts who can sign up
- **Onboarding flag** — `users.onboarded` tracks whether user has completed onboarding flow

### Session Management

- Sessions stored in database via better-auth
- Concurrent session limits (enterprise hardening)
- Admin force sign-out capability
- Auto-expire after 7 days of inactivity
- Session activity tracking (last active timestamp)

### API Keys

- Users create named API keys from Settings
- Only the prefix is stored in plaintext (for identification)
- Full key shown once at creation, then only the hash is stored
- Support for expiration dates
- `last_used` timestamp updated on each use

## RBAC Engine

The `RbacService` (`src/services/rbac.ts`) computes effective permissions per user.

### System Roles

| Role | Description |
|------|-------------|
| `admin` | Full platform access, user management, policy editing |
| `engineering` | Access to dev tools (GitHub, Jira, CI/CD) |
| `finance` | Access to financial tools and data |
| `sales` | Access to CRM and sales tools |
| `hr` | Access to people management tools |
| `leadership` | Cross-functional read access |
| `viewer` | Read-only access to allowed resources |

Users can have multiple roles. Teams provide additional grouping.

### Permission Resolution

The RBAC engine computes `EffectivePermissions` by:

1. **Collect** all policies for the user's roles, teams, and direct user policies
2. **Deny wins** — ANY policy with `access_level: none` = deny (regardless of other policies)
3. **Most permissive** — Among non-deny policies, take the most permissive access level
4. **Merge tool lists** — Union of allowed tools, union of denied tools (denied takes precedence)
5. **Rate limits** — Take the highest configured limit

```
EffectivePermissions {
  mcp: Map<connectionId, { access_level, allowed_tools, denied_tools, rate_limits }>
  knowledge: Map<sourceId, { access_level }>
  agents: Map<agentId, { access_level }>
  platform: { can_manage_users, can_edit_policies, can_view_audit, ... }
}
```

### Permission Types

#### MCP Access
- Which connections a user can access
- Read vs write per connection
- Specific tool allow/deny lists
- Data classification clearance
- Rate limits per connection

#### Knowledge Access
- Which knowledge sources a user can search/read
- Read vs write per source

#### Agent Access
- Which agents a user can chat with
- Which agents a user can configure

#### Platform Permissions
- User management (create, edit, deactivate)
- Policy editing
- Audit log viewing
- Settings access
- Schedule management

## Policy Types

### MCP Policies

Control tool access per connection. See [MCP Governance](./03-mcp-governance.md) for details.

### Knowledge Policies

```
principal (role/team/user) × knowledge_source → access_level (read/write/none)
```

Agents only return knowledge search results from sources the requesting user has access to.

### Agent Policies

```
principal (role/team/user) × agent → access_level (use/configure/none)
```

- `use` — Can chat with the agent
- `configure` — Can edit the agent's settings
- `none` — Agent hidden from this user

## Admin UI

### Users Page
- List all users with role badges
- Edit user roles and team memberships
- Deactivate/reactivate users
- Force sign-out

### Roles Page
- View role definitions and descriptions
- See which users have each role

### Policies Page
- **MCP tab** — Policy editor for connection access
- **Knowledge tab** — Policy editor for knowledge source access
- **Agent tab** — Policy editor for agent access
- **Access Matrix** — Visual grid of roles × connections, color-coded:
  - Green = write access
  - Yellow = read access
  - Red = denied
  - Gray = no policy (default deny)

### Tool Classification Page
Per connection, classify each discovered tool:
- `public` — No restrictions
- `internal` — Company employees only
- `confidential` — Role-restricted
- `restricted` — Explicit approval needed

## Onboarding

### First-Run Setup Wizard (Task 058)

Triggered when `setup_completed` flag is false:

1. **Welcome** — Introduction to Tela
2. **Admin Account** — First user becomes admin
3. **Company Info** — Name, timezone, allowed email domains
4. **Connect Tools** — Set up initial connections (Jira, GitHub, Google, Slack)
5. **Create Teams** — Define team structure
6. **Invite Users** — Email domain auto-provisioning
7. **Set Policies** — Apply initial access policies
8. **Done** — Setup complete

### Employee Onboarding

Triggered on first login when `users.onboarded` is false:

1. **Role Overview** — What you can access based on your roles
2. **Connect Accounts** — Prompt to connect delegated services (personal GitHub, Google)
3. **Quick Tour** — Key features walkthrough

## User-Delegated Connections (Task 053)

Some connections use the user's own credentials instead of shared company ones:

### How It Works

1. Connection configured with `token_strategy: 'delegated'`
2. User visits "My Connections" page
3. Clicks "Connect" → OAuth flow with their personal account
4. Token stored in `user_connections` table (encrypted)
5. When agent runs for this user, gateway injects user's token instead of company token

### My Connections Page

- Shows all delegated connections and their status (connected/disconnected)
- "Connect" button starts OAuth flow
- "Test" button verifies token is valid
- "Disconnect" removes stored token

### Credential Resolution Order

When gateway needs a token for a tool call:
1. **User's token** (from `user_connections`) if `delegated` strategy
2. **Company token** (from `connections`) if `company` strategy or user hasn't connected
