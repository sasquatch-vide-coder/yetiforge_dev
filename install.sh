#!/usr/bin/env bash
# ==============================================================================
#
#   YetiForge — One-Command Installer
#
#   AI-Powered Telegram Bot Framework
#
#   Usage:
#     curl -fsSL https://raw.githubusercontent.com/YOUR_USER/yetiforge/main/install.sh | bash
#
#     — or —
#
#     git clone https://github.com/YOUR_USER/yetiforge.git
#     cd yetiforge && bash install.sh
#
# ==============================================================================

set -euo pipefail

# Capture start time
SECONDS=0

# ──────────────────────────────────────────────────
# Determine installation mode
# ──────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null)" && pwd 2>/dev/null || echo "")"
REPO_URL="${YETIFORGE_REPO:-https://github.com/YOUR_USER/yetiforge.git}"
INSTALL_BRANCH="${YETIFORGE_BRANCH:-main}"

# If we're being piped from curl, we need to clone first
if [[ -z "$SCRIPT_DIR" ]] || [[ ! -f "${SCRIPT_DIR}/package.json" ]]; then
    # Running via curl pipe — clone repo first
    INSTALL_DIR="/opt/yetiforge"

    # Check for root/sudo early
    if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
        echo "Error: This installer requires root or sudo access."
        echo "Run with: curl -fsSL <url> | sudo bash"
        exit 1
    fi

    SUDO_CMD=""
    [[ $EUID -ne 0 ]] && SUDO_CMD="sudo"

    echo "Cloning YetiForge..."
    if [[ -d "$INSTALL_DIR" ]]; then
        echo "Existing installation found at ${INSTALL_DIR}"
        echo "Pulling latest changes..."
        cd "$INSTALL_DIR"
        git fetch origin "$INSTALL_BRANCH" 2>/dev/null
        git reset --hard "origin/$INSTALL_BRANCH" 2>/dev/null
    else
        $SUDO_CMD git clone -b "$INSTALL_BRANCH" "$REPO_URL" "$INSTALL_DIR"
    fi

    # Re-run this script from the cloned location
    cd "$INSTALL_DIR"
    exec bash install.sh
    exit 0
fi

# Running from local directory
INSTALL_DIR="$SCRIPT_DIR"

# ──────────────────────────────────────────────────
# Setup logging
# ──────────────────────────────────────────────────
INSTALL_LOG="/tmp/yetiforge-install-$(date +%Y%m%d%H%M%S).log"
touch "$INSTALL_LOG"

# Log everything to file as well
exec > >(tee -a "$INSTALL_LOG") 2>&1

# ──────────────────────────────────────────────────
# Source all modules
# ──────────────────────────────────────────────────
SETUP_DIR="${INSTALL_DIR}/setup"

source "${SETUP_DIR}/banner.sh"
source "${SETUP_DIR}/preflight.sh"
source "${SETUP_DIR}/install-deps.sh"
source "${SETUP_DIR}/configure.sh"
source "${SETUP_DIR}/build.sh"
source "${SETUP_DIR}/services.sh"
source "${SETUP_DIR}/ssl.sh"
source "${SETUP_DIR}/finalize.sh"

# ──────────────────────────────────────────────────
# Error trap
# ──────────────────────────────────────────────────
trap 'handle_error $? ${LINENO} "$BASH_COMMAND"' ERR

# ──────────────────────────────────────────────────
# Run installation
# ──────────────────────────────────────────────────
show_banner

echo -e "  ${WHITE}${BOLD}Welcome to the YetiForge installer!${NC}"
echo -e "  ${DIM}This will set up everything you need to run YetiForge on this server.${NC}"
echo -e "  ${DIM}The process takes about 3-5 minutes depending on your server.${NC}"
echo ""

prompt_yn "Ready to begin?" "y" BEGIN_INSTALL

if [[ "$BEGIN_INSTALL" != "true" ]]; then
    echo ""
    log_info "Installation cancelled. Run again when you're ready!"
    exit 0
fi

# Initialize variables
GIT_NEEDED=false
FRESH_CONFIG=true
SERVICE_WAS_RUNNING=false
HAS_DOMAIN=false
SSL_CONFIGURED=false
UFW_AVAILABLE=false

# Execute each phase
run_preflight         # Step 1: System checks
install_dependencies  # Step 2: Install Node, nginx, etc.
run_configuration     # Step 3: Interactive config wizard
run_build             # Step 4: npm install + build
setup_services        # Step 5: systemd + nginx
setup_ssl             # Step 6: Optional SSL
run_finalize          # Step 7: Health check + summary

# Cleanup
rm -f /tmp/yetiforge.service /tmp/yetiforge-nginx.conf

exit 0
