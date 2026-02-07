#!/usr/bin/env bash
# ==============================================================================
# YetiForge Installer — Interactive Configuration Wizard
# ==============================================================================

run_configuration() {
    step_header "Configuration"

    if [[ "$FRESH_CONFIG" != "true" ]]; then
        log_info "Using existing .env configuration"
        log_info "Edit ${INSTALL_DIR}/.env to change settings later"
        return 0
    fi

    echo ""
    echo -e "  ${WHITE}${BOLD}Let's set up your YetiForge instance.${NC}"
    echo -e "  ${DIM}Required fields are marked with *. Press Enter to accept defaults.${NC}"
    echo ""

    # ──────────────────────────────────────────────
    # Telegram Configuration
    # ──────────────────────────────────────────────
    echo -e "  ${BOLD}${MAGENTA}Telegram Bot Setup${NC}"
    echo -e "  ${DIM}Create a bot at https://t.me/BotFather to get your token${NC}"
    echo ""

    # Bot Token (required)
    while true; do
        prompt_secret "* Telegram Bot Token" CFG_BOT_TOKEN true
        # Basic format validation: numbers:alphanumeric
        if [[ "$CFG_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
            log_success "Bot token format looks valid"
            break
        else
            log_error "Invalid bot token format. Expected: 123456:ABC-DEF..."
            log_info "Get your token from @BotFather on Telegram"
        fi
    done

    echo ""

    # Allowed User IDs (required)
    echo -e "  ${DIM}Your Telegram user ID controls who can use the bot.${NC}"
    echo -e "  ${DIM}Send /start to @userinfobot on Telegram to find your ID.${NC}"
    echo -e "  ${DIM}Separate multiple IDs with commas.${NC}"
    while true; do
        prompt_with_default "* Allowed Telegram User IDs" "" CFG_USER_IDS true
        # Validate: comma-separated numbers
        if [[ "$CFG_USER_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
            log_success "User IDs set"
            break
        else
            log_error "Invalid format. Enter numeric IDs separated by commas (e.g., 123456789,987654321)"
        fi
    done

    echo ""

    # ──────────────────────────────────────────────
    # Server Configuration
    # ──────────────────────────────────────────────
    echo -e "  ${BOLD}${MAGENTA}Server Configuration${NC}"
    echo ""

    # Domain (optional)
    echo -e "  ${DIM}If you have a domain pointed to this server, enter it now.${NC}"
    echo -e "  ${DIM}Leave blank to use IP address only (http://your-server-ip:3069)${NC}"
    prompt_with_default "Domain name (optional)" "" CFG_DOMAIN false

    if [[ -n "$CFG_DOMAIN" ]]; then
        # Strip protocol if user included it
        CFG_DOMAIN=$(echo "$CFG_DOMAIN" | sed 's|https\?://||' | sed 's|/.*||')
        log_success "Domain: ${CFG_DOMAIN}"
        HAS_DOMAIN=true
    else
        HAS_DOMAIN=false
        log_info "No domain — will use IP-only access"
    fi

    echo ""

    # Status port
    prompt_with_default "Status dashboard port" "3069" CFG_PORT false
    log_success "Port: ${CFG_PORT}"

    echo ""

    # ──────────────────────────────────────────────
    # Project Configuration
    # ──────────────────────────────────────────────
    echo -e "  ${BOLD}${MAGENTA}Project Configuration${NC}"
    echo ""

    # Default project directory
    prompt_with_default "Default project directory" "/home/${INSTALL_USER}" CFG_PROJECT_DIR false
    log_success "Project dir: ${CFG_PROJECT_DIR}"

    echo ""

    # ──────────────────────────────────────────────
    # Claude CLI
    # ──────────────────────────────────────────────
    echo -e "  ${BOLD}${MAGENTA}Claude Code CLI${NC}"
    echo ""

    # Auto-detect Claude CLI
    local detected_claude=""
    if command -v claude &> /dev/null; then
        detected_claude=$(which claude)
    elif [[ -f "/home/${INSTALL_USER}/.local/bin/claude" ]]; then
        detected_claude="/home/${INSTALL_USER}/.local/bin/claude"
    elif [[ -f "/usr/local/bin/claude" ]]; then
        detected_claude="/usr/local/bin/claude"
    fi

    if [[ -n "$detected_claude" ]]; then
        log_success "Claude CLI detected at: ${detected_claude}"
        prompt_with_default "Claude CLI path" "$detected_claude" CFG_CLAUDE_PATH false
    else
        log_warn "Claude CLI not found on this system"
        echo -e "  ${DIM}YetiForge needs the Claude Code CLI for AI-powered task execution.${NC}"
        echo -e "  ${DIM}Install it later with: npm install -g @anthropic-ai/claude-code${NC}"
        echo -e "  ${DIM}Then authenticate with: claude auth${NC}"
        prompt_with_default "Claude CLI path (or press Enter to skip)" "claude" CFG_CLAUDE_PATH false
    fi

    echo ""

    # ──────────────────────────────────────────────
    # Security
    # ──────────────────────────────────────────────
    echo -e "  ${BOLD}${MAGENTA}Security${NC}"
    echo ""

    # JWT Secret
    local auto_secret
    auto_secret=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '=/+' | head -c 64)

    echo -e "  ${DIM}JWT secret is used to sign admin dashboard tokens.${NC}"
    echo -e "  ${DIM}Press Enter to auto-generate a secure random secret.${NC}"
    prompt_with_default "Admin JWT Secret" "$auto_secret" CFG_JWT_SECRET false
    log_success "JWT secret configured"

    echo ""

    # ──────────────────────────────────────────────
    # Optional: GitHub PAT
    # ──────────────────────────────────────────────
    echo -e "  ${BOLD}${MAGENTA}Optional Integrations${NC}"
    echo ""

    prompt_yn "Configure GitHub integration?" "n" SETUP_GITHUB
    if [[ "$SETUP_GITHUB" == "true" ]]; then
        echo -e "  ${DIM}GitHub PAT enables repo management features.${NC}"
        echo -e "  ${DIM}Generate one at: https://github.com/settings/tokens${NC}"
        prompt_secret "GitHub Personal Access Token" CFG_GITHUB_PAT false
    else
        CFG_GITHUB_PAT=""
    fi

    echo ""

    # ──────────────────────────────────────────────
    # Claude timeout
    # ──────────────────────────────────────────────
    prompt_with_default "Claude CLI timeout (ms)" "300000" CFG_CLAUDE_TIMEOUT false

    echo ""

    # ──────────────────────────────────────────────
    # Write .env file
    # ──────────────────────────────────────────────
    log_step "Writing configuration to .env..."

    cat > "${INSTALL_DIR}/.env" << ENVFILE
# ==============================================================================
# YetiForge Configuration
# Generated by installer on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# ==============================================================================

# --- Telegram Bot (REQUIRED) ---
# Your bot token from @BotFather
TELEGRAM_BOT_TOKEN=${CFG_BOT_TOKEN}

# Comma-separated Telegram user IDs allowed to use the bot
# Find your ID: send /start to @userinfobot
ALLOWED_USER_IDS=${CFG_USER_IDS}

# --- Server ---
# Port for the status dashboard and API
STATUS_PORT=${CFG_PORT}

# Public hostname for webhook URLs (optional — set to your domain or IP)
$([ -n "$CFG_DOMAIN" ] && echo "STATUS_HOST=${CFG_DOMAIN}" || echo "# STATUS_HOST=your-domain.com")
$([ -n "$CFG_DOMAIN" ] && echo "WEBHOOK_HOST=${CFG_DOMAIN}" || echo "# WEBHOOK_HOST=your-domain.com")

# --- Claude Code CLI ---
# Path to the Claude Code CLI binary
CLAUDE_CLI_PATH=${CFG_CLAUDE_PATH}

# Max time (ms) to wait for Claude CLI responses
CLAUDE_TIMEOUT_MS=${CFG_CLAUDE_TIMEOUT}

# --- Projects ---
# Default directory for Claude Code to work in
DEFAULT_PROJECT_DIR=${CFG_PROJECT_DIR}

# --- Data ---
# Directory for persistent data (SQLite DB, JSON files, backups)
DATA_DIR=./data

# --- Security ---
# Secret key for signing admin dashboard JWT tokens
ADMIN_JWT_SECRET=${CFG_JWT_SECRET}

# --- Optional: GitHub ---
$([ -n "$CFG_GITHUB_PAT" ] && echo "GITHUB_PAT=${CFG_GITHUB_PAT}" || echo "# GITHUB_PAT=ghp_your_token_here")
ENVFILE

    chmod 600 "${INSTALL_DIR}/.env"
    log_success "Configuration saved to .env (permissions: 600)"

    echo ""
    log_success "Configuration complete"
}
