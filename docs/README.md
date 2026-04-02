# Tela Wiki

**Tela** is an AI operating system for companies — a platform that connects AI agents to your tools, knowledge, and workflows with enterprise-grade governance.

Built on [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-sdk) and [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), Tela lets organizations deploy specialized AI agents that can access company tools (Jira, GitHub, Slack, Google Workspace), search internal knowledge bases, run on schedules, and operate within strict role-based access controls.

---

## Wiki Pages

### Core System
| Page | Description |
|------|-------------|
| [Overview & Architecture](./01-overview-and-architecture.md) | System design, principles, tech stack, and high-level architecture |
| [Agent System](./02-agent-system.md) | Agent core, orchestrator, multi-agent coordination, council & batch modes |
| [MCP Governance](./03-mcp-governance.md) | Gateway, policies, tool execution pipeline, permission hardening |

### Data & Knowledge
| Page | Description |
|------|-------------|
| [Knowledge System](./04-knowledge-system.md) | Adapters, vector store, ingestion, semantic search, vault tools |
| [Database & Persistence](./05-database-and-persistence.md) | Schema, migrations, audit log, cost tracking, memory tables |

### Access Control
| Page | Description |
|------|-------------|
| [Auth, RBAC & Governance](./06-auth-rbac-and-governance.md) | Authentication, roles, teams, policies, permission resolution |
| [Security & Safety](./07-security-and-safety.md) | Prompt injection defense, hardening, bypass-immune checks, error resilience |

### Platform
| Page | Description |
|------|-------------|
| [Integrations](./08-integrations.md) | Google, GitHub, Jira, ShipLens, Telegram, Slack connections |
| [Runtime & Execution](./09-runtime-and-execution.md) | Runtime abstraction, streaming, compaction, circuit breakers, cost optimization |
| [Scheduling & Notifications](./10-scheduling-and-notifications.md) | Cron jobs, built-in schedules, notification channels, smart filtering |

### Interface & Operations
| Page | Description |
|------|-------------|
| [Frontend & UI](./11-frontend-and-ui.md) | React app, chat UI, admin panels, setup wizard |
| [Deployment & Operations](./12-deployment-and-operations.md) | Docker, Nix, environment variables, health checks, monitoring |

---

## System Map

```mermaid
graph TD
    Frontend["Frontend<br/><i>React + Shadcn/ui</i>"] --> API["Hono API<br/><i>REST + WebSocket</i>"]

    API --> Orchestrator["Orchestrator<br/><i>Agent Routing</i>"]
    API --> Auth["Auth + RBAC<br/><i>Governance</i>"]
    API --> Scheduling["Scheduling<br/><i>Cron Jobs</i>"]

    Orchestrator --> Runtime["Agent Runtime<br/><i>In-Process / Agent OS / Docker</i>"]
    Scheduling --> Runtime

    Runtime --> Gateway["MCP Gateway<br/><i>Tool Governance</i>"]
    Runtime --> Knowledge["Knowledge Manager<br/><i>Vector Search</i>"]

    Gateway --> MCP["MCP Servers<br/><i>Jira · GitHub · Slack<br/>Google · ShipLens · ...</i>"]
    Knowledge --> Sources["Knowledge Sources<br/><i>Obsidian · Filesystem<br/>Notion · Confluence</i>"]

    style Frontend fill:#4f46e5,color:#fff
    style API fill:#3b82f6,color:#fff
    style Runtime fill:#8b5cf6,color:#fff
    style Gateway fill:#f59e0b,color:#fff
    style Knowledge fill:#10b981,color:#fff
    style Auth fill:#6366f1,color:#fff
    style Orchestrator fill:#6366f1,color:#fff
    style Scheduling fill:#6366f1,color:#fff
    style MCP fill:#f97316,color:#fff
    style Sources fill:#059669,color:#fff
```

---

## Quick Links

- **Getting Started**: See the project [README.md](../README.md) for setup instructions
- **Design Decisions**: See [ARCHITECTURE.md](../ARCHITECTURE.md) for design principles
- **Task History**: See [tasks/](../tasks/) for the full development history
