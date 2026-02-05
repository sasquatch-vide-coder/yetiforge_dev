# Rumpbot

Personal Telegram bot that bridges messages to Claude Code CLI.

## Tech Stack
- TypeScript ES modules, Node.js
- grammY for Telegram
- Claude Code CLI spawned via child_process
- JSON file persistence in data/

## Commands
- `npm run dev` - Run with tsx (development)
- `npm run build` - Compile TypeScript
- `npm start` - Run compiled JS (production)

## Architecture
Telegram messages → grammY bot (always running) → `claude -p` spawned per message → response sent back.
Sessions are resumed via `--resume <sessionId>` for conversation continuity.

## Deployment (VPS)
- **Host**: `ubuntu@129.146.23.173`
- **SSH**: `ssh -i "ssh/ssh-key-2026-02-04.key" ubuntu@129.146.23.173`
- **App path**: `/home/ubuntu/rumpbot`
- **Service**: `sudo systemctl {start|stop|restart|status} rumpbot`
- **Logs**: `sudo journalctl -u rumpbot -f`

## GitHub
- **Repo**: https://github.com/sasquatch-vide-coder/rumpbot
- **PAT**: Stored in `.env` as `GITHUB_PAT`

### Deploy steps
```bash
# From local machine (D:\Coding\rumpbot):
scp -i "ssh/ssh-key-2026-02-04.key" -r src/ package.json package-lock.json tsconfig.json rumpbot.service CLAUDE.md .env.example ubuntu@129.146.23.173:/home/ubuntu/rumpbot/

# On VPS:
cd /home/ubuntu/rumpbot && npm install && npm run build
sudo cp rumpbot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart rumpbot
```
