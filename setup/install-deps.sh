#!/usr/bin/env bash
# ==============================================================================
# YetiForge Installer — Dependency Installation
# ==============================================================================

install_dependencies() {
    step_header "Installing Dependencies"

    # --- Update package lists ---
    log_step "Updating package lists..."
    $SUDO_CMD apt-get update -qq >> "$INSTALL_LOG" 2>&1
    log_success "Package lists updated"

    # --- Essential packages ---
    local base_packages="curl wget gnupg2 ca-certificates lsb-release software-properties-common build-essential"
    log_step "Installing base packages..."
    $SUDO_CMD apt-get install -y -qq $base_packages >> "$INSTALL_LOG" 2>&1
    log_success "Base packages installed"

    # --- Git ---
    if [[ "$GIT_NEEDED" == "true" ]] || ! command -v git &> /dev/null; then
        log_step "Installing Git..."
        $SUDO_CMD apt-get install -y -qq git >> "$INSTALL_LOG" 2>&1
        log_success "Git installed: $(git --version)"
    else
        log_success "Git: already installed"
    fi

    # --- Node.js 22 ---
    if command -v node &> /dev/null; then
        local node_ver
        node_ver=$(node -v 2>/dev/null | sed 's/v//')
        local node_major="${node_ver%%.*}"
        if [[ "$node_major" -ge 22 ]]; then
            log_success "Node.js: v${node_ver} (already installed)"
            SKIP_NODE=true
        else
            log_warn "Node.js v${node_ver} found but v22+ required"
            SKIP_NODE=false
        fi
    else
        SKIP_NODE=false
    fi

    if [[ "$SKIP_NODE" != "true" ]]; then
        log_step "Installing Node.js 22..."

        # NodeSource setup
        if [[ ! -f /etc/apt/sources.list.d/nodesource.list ]] && [[ ! -f /usr/share/keyrings/nodesource.gpg ]]; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO_CMD -E bash - >> "$INSTALL_LOG" 2>&1
        fi

        $SUDO_CMD apt-get install -y -qq nodejs >> "$INSTALL_LOG" 2>&1

        if command -v node &> /dev/null; then
            log_success "Node.js installed: $(node -v)"
        else
            log_error "Node.js installation failed. Check ${INSTALL_LOG}"
            exit 1
        fi
    fi

    # --- npm check ---
    if command -v npm &> /dev/null; then
        log_success "npm: $(npm -v)"
    else
        log_error "npm not found after Node.js installation."
        exit 1
    fi

    # --- Nginx ---
    if command -v nginx &> /dev/null; then
        log_success "Nginx: already installed"
    else
        log_step "Installing Nginx..."
        $SUDO_CMD apt-get install -y -qq nginx >> "$INSTALL_LOG" 2>&1
        if command -v nginx &> /dev/null; then
            log_success "Nginx installed: $(nginx -v 2>&1)"
        else
            log_error "Nginx installation failed. Check ${INSTALL_LOG}"
            exit 1
        fi
    fi

    # --- Certbot (for optional SSL) ---
    if command -v certbot &> /dev/null; then
        log_success "Certbot: already installed"
    else
        log_step "Installing Certbot..."
        $SUDO_CMD apt-get install -y -qq certbot python3-certbot-nginx >> "$INSTALL_LOG" 2>&1
        if command -v certbot &> /dev/null; then
            log_success "Certbot installed"
        else
            log_warn "Certbot installation failed — SSL setup will be unavailable"
        fi
    fi

    # --- UFW (firewall) ---
    if command -v ufw &> /dev/null; then
        log_success "UFW firewall: available"
        UFW_AVAILABLE=true
    else
        log_info "UFW not installed — firewall rules must be managed manually"
        UFW_AVAILABLE=false
    fi

    echo ""
    log_success "All dependencies installed"
}
