#!/usr/bin/env bash
# ==============================================================================
# YetiForge Installer — Finalization & Summary
# ==============================================================================

run_finalize() {
    step_header "Finalizing Installation"

    local status_port="${CFG_PORT:-3069}"

    # ──────────────────────────────────────────────
    # Start the service
    # ──────────────────────────────────────────────
    log_step "Starting YetiForge service..."
    $SUDO_CMD systemctl start tiffbot

    # Wait a moment for startup
    sleep 3

    # ──────────────────────────────────────────────
    # Health Check
    # ──────────────────────────────────────────────
    log_step "Running health check..."

    local health_ok=false
    local retries=0
    local max_retries=5

    while [[ $retries -lt $max_retries ]]; do
        if curl -sf "http://localhost:${status_port}/api/health" > /dev/null 2>&1; then
            health_ok=true
            break
        fi
        retries=$((retries + 1))
        sleep 2
    done

    if [[ "$health_ok" == "true" ]]; then
        log_success "Health check passed — YetiForge is running!"
    else
        log_warn "Health check failed after ${max_retries} attempts"
        log_info "The service may still be starting up. Check with:"
        log_info "  sudo systemctl status tiffbot"
        log_info "  sudo journalctl -u tiffbot -f"
    fi

    # ──────────────────────────────────────────────
    # Determine access URLs
    # ──────────────────────────────────────────────
    local server_ip
    server_ip=$(curl -sf --connect-timeout 3 https://ifconfig.me 2>/dev/null || curl -sf --connect-timeout 3 https://icanhazip.com 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')

    local dashboard_url=""
    local api_url=""
    local protocol="http"

    if [[ "$SSL_CONFIGURED" == "true" ]]; then
        protocol="https"
    fi

    if [[ "$HAS_DOMAIN" == "true" && -n "$CFG_DOMAIN" ]]; then
        dashboard_url="${protocol}://${CFG_DOMAIN}"
        api_url="${protocol}://${CFG_DOMAIN}/api/status"
    else
        dashboard_url="http://${server_ip}:${status_port}"
        api_url="http://${server_ip}:${status_port}/api/status"
    fi

    # ──────────────────────────────────────────────
    # Installation Summary
    # ──────────────────────────────────────────────
    local install_time=$((SECONDS / 60))

    echo ""
    echo ""
    echo -e "${CYAN}"
    cat << 'DONE'
    ╔══════════════════════════════════════════════════════════════════╗
    ║                                                                  ║
    ║        🎉  YetiForge Installation Complete!  🎉                 ║
    ║                                                                  ║
    ╚══════════════════════════════════════════════════════════════════╝
DONE
    echo -e "${NC}"

    echo -e "  ${WHITE}${BOLD}Access Your Instance${NC}"
    echo -e "  ${DIM}────────────────────────────────────────────────────${NC}"
    echo -e "  ${ARROW}  Dashboard:  ${GREEN}${BOLD}${dashboard_url}${NC}"
    echo -e "  ${ARROW}  API Status: ${GREEN}${api_url}${NC}"
    echo -e "  ${ARROW}  Admin:      ${GREEN}${dashboard_url}/admin${NC}"
    echo ""

    echo -e "  ${WHITE}${BOLD}Telegram Bot${NC}"
    echo -e "  ${DIM}────────────────────────────────────────────────────${NC}"
    echo -e "  ${ARROW}  Open Telegram and send ${WHITE}/start${NC} to your bot"
    echo -e "  ${ARROW}  The bot will respond if your user ID is authorized"
    echo ""

    echo -e "  ${WHITE}${BOLD}Admin Dashboard Setup${NC}"
    echo -e "  ${DIM}────────────────────────────────────────────────────${NC}"
    echo -e "  ${ARROW}  Visit ${WHITE}${dashboard_url}/admin${NC}"
    echo -e "  ${ARROW}  On first visit, you'll create an admin account"
    echo -e "  ${ARROW}  Optional: Enable 2FA for extra security"
    echo ""

    echo -e "  ${WHITE}${BOLD}Useful Commands${NC}"
    echo -e "  ${DIM}────────────────────────────────────────────────────${NC}"
    echo -e "  ${ARROW}  Service status:   ${WHITE}sudo systemctl status tiffbot${NC}"
    echo -e "  ${ARROW}  View logs:        ${WHITE}sudo journalctl -u tiffbot -f${NC}"
    echo -e "  ${ARROW}  Restart service:  ${WHITE}sudo systemctl restart tiffbot${NC}"
    echo -e "  ${ARROW}  Stop service:     ${WHITE}sudo systemctl stop tiffbot${NC}"
    echo -e "  ${ARROW}  Edit config:      ${WHITE}nano ${INSTALL_DIR}/.env${NC}"
    echo ""

    # Claude CLI warning if not found
    if ! command -v claude &> /dev/null && [[ ! -f "${CFG_CLAUDE_PATH}" ]]; then
        echo -e "  ${WHITE}${BOLD}⚠ Claude Code CLI${NC}"
        echo -e "  ${DIM}────────────────────────────────────────────────────${NC}"
        echo -e "  ${WARN}  Claude CLI not found — bot chat will work, but"
        echo -e "      AI-powered task execution requires Claude Code CLI."
        echo -e "  ${ARROW}  Install:    ${WHITE}npm install -g @anthropic-ai/claude-code${NC}"
        echo -e "  ${ARROW}  Auth:       ${WHITE}claude auth${NC}"
        echo -e "  ${ARROW}  Then restart: ${WHITE}sudo systemctl restart tiffbot${NC}"
        echo ""
    fi

    if [[ "$HAS_DOMAIN" == "true" && "$SSL_CONFIGURED" != "true" ]]; then
        echo -e "  ${WHITE}${BOLD}🔒 SSL Certificate${NC}"
        echo -e "  ${DIM}────────────────────────────────────────────────────${NC}"
        echo -e "  ${ARROW}  Set up HTTPS: ${WHITE}sudo certbot --nginx -d ${CFG_DOMAIN}${NC}"
        echo ""
    fi

    echo -e "  ${DIM}Installation took ~${install_time} minute(s)${NC}"
    echo -e "  ${DIM}Log file: ${INSTALL_LOG}${NC}"
    echo -e "  ${DIM}Install dir: ${INSTALL_DIR}${NC}"
    echo ""
    echo -e "  ${MAGENTA}${BOLD}Happy forging! ⚒️${NC}"
    echo ""
}
