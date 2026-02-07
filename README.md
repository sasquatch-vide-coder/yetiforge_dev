# TIFFBOT 🤖

A personal AI assistant that lives in Telegram, powered by Claude Code CLI and a three-tier agent architecture. She's snarky, she's opinionated, and she gets the job done — whether you asked nicely or not.

Meet **Tiffany**: a passive-aggressive Russian woman who happens to be one of the most capable AI assistants you'll ever work with. She manages code, runs commands, debugs your mistakes, and only judges you a little.

## How It Works

```
You (Telegram) → Tiffany → Claude Code CLI → Your Codebase
```

Every message you send goes through a **three-tier agent pipeline**:

| Tier | Agent | Model | Role |
|------|-------|-------|------|
| 1 | **Chat Agent** | Haiku | Responds instantly as Tiffany. Decides if you're just chatting or asking for real work. |
| 2 | **Orchestrator** | Opus | Plans complex tasks, breaks them into steps, manages dependencies. |
| 3 | **Worker(s)** | Opus | Executes actual work — file edits, git operations, builds, debugging. Runs in parallel when possible. |

Casual conversation gets a fast Tiffany response. Work requests trigger the full pipeline — you get an immediate acknowledgment, then background orchestration handles the heavy lifting.

## Features

### Telegram Bot
- **Natural conversation** with persistent session memory
- **Multi-project support** — switch between codebases on the fly
- **Git operations** — commit, push, and PR creation via commands
- **Media handling** — processes images and files sent in chat
- **Rate limiting** — prevents overlapping requests per chat
- **User allowlist** — only authorized Telegram users get access

### Admin Dashboard
- **Neo Brutalist UI** — React + Vite + Tailwind, served at your domain
- **JWT + TOTP MFA** authentication
- **Live system monitoring** — service health, CPU, memory, uptime
- **Cost tracking** — per-invocation logging of tokens, cost, and duration
- **Agent configuration** — change models, max turns, and timeouts per tier
- **Claude CLI management** — check and update versions from the dashboard
- **Telegram config editing** — manage bot settings without SSH
- **SSL/TLS status** — certificate monitoring
- **Web chat interface** — talk to Tiffany from the browser

### Bot Commands
| Command | Description |
|---------|-------------|
| `/start` | Introduction |
| `/help` | Show available commands |
| `/status` | Session & project info |
| `/reset` | Clear conversation history |
| `/cancel` | Abort a running request |
| `/model` | Show agent configurations |
| `/project list\|add\|switch\|remove` | Manage working directories |
| `/git status\|commit\|push\|pr` | Git operations |

## Tech Stack

- **Runtime**: Node.js + TypeScript (ES modules)
- **Bot Framework**: [grammY](https://grammy.dev/)
- **AI Backend**: Claude Code CLI (spawned as subprocess)
- **API Server**: [Fastify](https://fastify.dev/)
- **Frontend**: React + Vite + Tailwind CSS
- **Auth**: JWT + TOTP (via `otpauth`)
- **Logging**: Pino
- **Persistence**: JSON files (no database required)
- **Deployment**: systemd service on Ubuntu (Oracle Cloud)

## Project Structure

```
src/
├── agents/           # Three-tier agent system
│   ├── chat-agent.ts       # Tier 1: User-facing, personality layer
│   ├── orchestrator.ts     # Tier 2: Task planning & coordination
│   ├── worker.ts           # Tier 3: Task execution
│   ├── prompts.ts          # System prompts for all tiers
│   └── types.ts            # Shared interfaces
├── handlers/         # Telegram message & command handlers
├── claude/           # CLI invocation & session management
├── admin/            # Dashboard auth, routes, web chat
├── status/           # Fastify server & invocation logging
├── middleware/        # Auth & rate limiting
├── projects/         # Multi-project management
└── utils/            # Logger & Telegram helpers

status/
└── client/           # React dashboard (Vite + Tailwind)

data/                 # Persistent JSON storage
docs/                 # Personality spec & documentation
```

## Setup

### Prerequisites
- Node.js 22+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Telegram bot token (via [@BotFather](https://t.me/BotFather))

### Installation

```bash
git clone https://github.com/sasquatch-vide-coder/yetiforge.git
cd yetiforge
npm install
cd status/client && npm install && cd ../..
```

### Configuration

Create a `.env` file in the project root:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
ALLOWED_USER_IDS=123456789,987654321
DEFAULT_PROJECT_DIR=/home/user/projects/default
CLAUDE_CLI_PATH=claude
CLAUDE_TIMEOUT_MS=300000
DATA_DIR=./data
ADMIN_JWT_SECRET=your-secret-key
STATUS_PORT=3069
```

### Build & Run

```bash
# Build everything
npm run build:all

# Start
npm start

# Or run in dev mode
npm run dev
```

### Deploy as a Service

```bash
sudo cp tiffbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tiffbot
sudo systemctl start tiffbot

# Check logs
sudo journalctl -u tiffbot -f
```

### Reverse Proxy (Nginx)

The status page runs on port 3069. Point Nginx (or your preferred proxy) at it for HTTPS access:

```nginx
server {
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3069;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Telegram User                   │
└──────────────────────┬──────────────────────────┘
                       │
              ┌────────▼────────┐
              │   grammY Bot    │
              │   (handlers)    │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │   Chat Agent    │  ◄── Haiku (fast, cheap)
              │   (Tiffany)     │
              └───┬─────────┬───┘
                  │         │
            Just chat    Work request
                  │         │
         ┌────────▼──┐  ┌───▼──────────┐
         │  Respond   │  │ Orchestrator │  ◄── Opus (smart, thorough)
         │  directly  │  │  (planner)   │
         └───────────┘  └───┬──────────┘
                            │
                   ┌────────▼────────┐
                   │    Worker(s)    │  ◄── Opus (parallel execution)
                   │   (executors)   │
                   └────────┬────────┘
                            │
                   ┌────────▼────────┐
                   │  Claude Code    │
                   │     CLI         │
                   └─────────────────┘
```

## License

Private project. Not currently accepting contributions.

---

*Built with frustration, caffeine, and Claude. Tiffany disapproves of this README but wrote it anyway.*
