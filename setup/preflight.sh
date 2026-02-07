#!/usr/bin/env bash
# ==============================================================================
# YetiForge Installer — Preflight Checks
# ==============================================================================

run_preflight() {
    step_header "Preflight Checks"

    # --- Root / Sudo Check ---
    if [[ $EUID -eq 0 ]]; then
        INSTALL_USER="root"
        SUDO_CMD=""
        log_success "Running as root"
    elif sudo -n true 2>/dev/null; then
        INSTALL_USER=$(whoami)
        SUDO_CMD="sudo"
        log_success "Running as ${INSTALL_USER} with sudo access"
    else
        log_error "This installer requires root or sudo access."
        log_info "Run with: sudo bash install.sh"
        exit 1
    fi

    # --- OS Detection ---
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        OS_NAME="$ID"
        OS_VERSION="$VERSION_ID"
        OS_PRETTY="$PRETTY_NAME"
    else
        log_error "Cannot detect operating system. /etc/os-release not found."
        log_info "YetiForge requires Ubuntu 20.04+ or Debian 11+"
        exit 1
    fi

    case "$OS_NAME" in
        ubuntu)
            if [[ "${OS_VERSION%%.*}" -lt 20 ]]; then
                log_error "Ubuntu ${OS_VERSION} is not supported. Requires 20.04+"
                exit 1
            fi
            log_success "OS: ${OS_PRETTY}"
            ;;
        debian)
            if [[ "${OS_VERSION%%.*}" -lt 11 ]]; then
                log_error "Debian ${OS_VERSION} is not supported. Requires 11+"
                exit 1
            fi
            log_success "OS: ${OS_PRETTY}"
            ;;
        *)
            log_warn "Unsupported OS: ${OS_PRETTY}"
            log_warn "YetiForge is tested on Ubuntu 20.04+ and Debian 11+"
            prompt_yn "Continue anyway? (things might break)" "n" CONTINUE_UNSUPPORTED
            if [[ "$CONTINUE_UNSUPPORTED" != "true" ]]; then
                exit 1
            fi
            ;;
    esac

    # --- Architecture ---
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64|amd64)
            log_success "Architecture: x86_64"
            ;;
        aarch64|arm64)
            log_success "Architecture: ARM64"
            ;;
        *)
            log_warn "Unusual architecture: ${ARCH}. May encounter issues."
            ;;
    esac

    # --- Memory Check ---
    TOTAL_MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')
    if [[ -n "$TOTAL_MEM_MB" ]]; then
        if [[ "$TOTAL_MEM_MB" -lt 512 ]]; then
            log_warn "Low memory: ${TOTAL_MEM_MB}MB. Recommended: 1GB+"
            log_warn "Build process may fail or be very slow."
        else
            log_success "Memory: ${TOTAL_MEM_MB}MB"
        fi
    fi

    # --- Disk Space Check ---
    AVAIL_DISK_MB=$(df -m "${INSTALL_DIR}" 2>/dev/null | awk 'NR==2{print $4}')
    if [[ -n "$AVAIL_DISK_MB" ]]; then
        if [[ "$AVAIL_DISK_MB" -lt 1024 ]]; then
            log_warn "Low disk space: ${AVAIL_DISK_MB}MB available. Recommended: 2GB+"
        else
            log_success "Disk space: ${AVAIL_DISK_MB}MB available"
        fi
    fi

    # --- Internet Connectivity ---
    if curl -sf --connect-timeout 5 https://registry.npmjs.org/ > /dev/null 2>&1; then
        log_success "Internet: Connected (npm registry reachable)"
    elif curl -sf --connect-timeout 5 https://google.com > /dev/null 2>&1; then
        log_success "Internet: Connected"
        log_warn "npm registry unreachable — install may have issues"
    else
        log_error "No internet connectivity detected."
        log_info "YetiForge installer requires internet to download dependencies."
        exit 1
    fi

    # --- Git Check ---
    if command -v git &> /dev/null; then
        log_success "Git: $(git --version | head -1)"
    else
        log_step "Git not found — will be installed"
        GIT_NEEDED=true
    fi

    # --- Existing Installation Check ---
    if [[ -f "${INSTALL_DIR}/.env" ]]; then
        log_warn "Existing YetiForge installation detected at ${INSTALL_DIR}"
        prompt_yn "Overwrite configuration? (your .env will be backed up)" "n" OVERWRITE_CONFIG
        if [[ "$OVERWRITE_CONFIG" == "true" ]]; then
            local backup_name=".env.backup.$(date +%Y%m%d%H%M%S)"
            cp "${INSTALL_DIR}/.env" "${INSTALL_DIR}/${backup_name}"
            log_success "Backed up existing .env to ${backup_name}"
            FRESH_CONFIG=true
        else
            FRESH_CONFIG=false
            log_info "Keeping existing configuration"
        fi
    else
        FRESH_CONFIG=true
    fi

    # --- Check for running service ---
    if systemctl is-active --quiet tiffbot 2>/dev/null; then
        log_warn "YetiForge service (tiffbot) is currently running"
        log_info "It will be restarted after installation completes"
        SERVICE_WAS_RUNNING=true
    else
        SERVICE_WAS_RUNNING=false
    fi

    echo ""
    log_success "Preflight checks passed"
}
