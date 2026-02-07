#!/usr/bin/env bash
# ==============================================================================
# YetiForge — Uninstaller
#
# Usage: bash setup/uninstall.sh
#
# Cleanly removes YetiForge services, configs, and optionally all data.
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

CHECK="${GREEN}✓${NC}"
WARN="${YELLOW}⚠${NC}"
ARROW="${CYAN}→${NC}"

SUDO_CMD=""
[[ $EUID -ne 0 ]] && SUDO_CMD="sudo"

echo ""
echo -e "  ${CYAN}${BOLD}YetiForge Uninstaller${NC}"
echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo ""
echo -e "  ${WARN}  ${YELLOW}This will remove YetiForge from your system.${NC}"
echo ""

# Determine install dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${SCRIPT_DIR}"

echo -en "  ${ARROW}  Are you sure you want to uninstall? ${DIM}[y/N]${NC}: "
read -r confirm
if [[ "${confirm,,}" != "y" && "${confirm,,}" != "yes" ]]; then
    echo -e "  ${CHECK}  Uninstall cancelled"
    exit 0
fi

echo ""

# --- Stop and disable service ---
if systemctl is-active --quiet tiffbot 2>/dev/null; then
    echo -e "  ${ARROW}  Stopping tiffbot service..."
    $SUDO_CMD systemctl stop tiffbot
    echo -e "  ${CHECK}  Service stopped"
fi

if systemctl is-enabled --quiet tiffbot 2>/dev/null; then
    echo -e "  ${ARROW}  Disabling tiffbot service..."
    $SUDO_CMD systemctl disable tiffbot >> /dev/null 2>&1
    echo -e "  ${CHECK}  Service disabled"
fi

if [[ -f /etc/systemd/system/tiffbot.service ]]; then
    $SUDO_CMD rm -f /etc/systemd/system/tiffbot.service
    $SUDO_CMD systemctl daemon-reload
    echo -e "  ${CHECK}  systemd unit file removed"
fi

# --- Remove nginx config ---
if [[ -f /etc/nginx/sites-enabled/yetiforge ]]; then
    $SUDO_CMD rm -f /etc/nginx/sites-enabled/yetiforge
    echo -e "  ${CHECK}  Nginx site disabled"
fi

if [[ -f /etc/nginx/sites-available/yetiforge ]]; then
    $SUDO_CMD rm -f /etc/nginx/sites-available/yetiforge
    echo -e "  ${CHECK}  Nginx config removed"
fi

if command -v nginx &> /dev/null; then
    $SUDO_CMD systemctl reload nginx 2>/dev/null || true
fi

# --- Remove data? ---
echo ""
echo -en "  ${WARN}  Remove all data (database, sessions, backups)? ${DIM}[y/N]${NC}: "
read -r remove_data

if [[ "${remove_data,,}" == "y" || "${remove_data,,}" == "yes" ]]; then
    if [[ -d "${INSTALL_DIR}/data" ]]; then
        rm -rf "${INSTALL_DIR}/data"
        echo -e "  ${CHECK}  Data directory removed"
    fi
else
    echo -e "  ${CHECK}  Data preserved at ${INSTALL_DIR}/data"
fi

# --- Remove .env? ---
echo -en "  ${WARN}  Remove .env configuration? ${DIM}[y/N]${NC}: "
read -r remove_env

if [[ "${remove_env,,}" == "y" || "${remove_env,,}" == "yes" ]]; then
    if [[ -f "${INSTALL_DIR}/.env" ]]; then
        rm -f "${INSTALL_DIR}/.env"
        echo -e "  ${CHECK}  .env removed"
    fi
else
    echo -e "  ${CHECK}  .env preserved"
fi

# --- Remove node_modules and dist? ---
echo -en "  ${ARROW}  Remove build artifacts (node_modules, dist)? ${DIM}[Y/n]${NC}: "
read -r remove_build
remove_build="${remove_build:-y}"

if [[ "${remove_build,,}" == "y" || "${remove_build,,}" == "yes" ]]; then
    rm -rf "${INSTALL_DIR}/node_modules" "${INSTALL_DIR}/dist"
    rm -rf "${INSTALL_DIR}/status/client/node_modules" "${INSTALL_DIR}/status/client/dist"
    echo -e "  ${CHECK}  Build artifacts removed"
fi

# --- Remove entire directory? ---
echo ""
echo -en "  ${WARN}  Remove entire YetiForge directory (${INSTALL_DIR})? ${DIM}[y/N]${NC}: "
read -r remove_all

if [[ "${remove_all,,}" == "y" || "${remove_all,,}" == "yes" ]]; then
    cd /
    rm -rf "${INSTALL_DIR}"
    echo -e "  ${CHECK}  Directory removed"
fi

# --- UFW cleanup ---
if command -v ufw &> /dev/null; then
    echo ""
    echo -en "  ${ARROW}  Remove firewall rules for ports 80, 443, 3069? ${DIM}[y/N]${NC}: "
    read -r remove_ufw

    if [[ "${remove_ufw,,}" == "y" || "${remove_ufw,,}" == "yes" ]]; then
        $SUDO_CMD ufw delete allow 3069/tcp 2>/dev/null || true
        echo -e "  ${CHECK}  Firewall rules cleaned up"
    fi
fi

echo ""
echo -e "  ${GREEN}${BOLD}YetiForge has been uninstalled.${NC}"
echo -e "  ${DIM}Node.js and Nginx were left installed (they may be used by other apps).${NC}"
echo ""
