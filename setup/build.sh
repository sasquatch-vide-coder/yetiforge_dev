#!/usr/bin/env bash
# ==============================================================================
# YetiForge Installer — Build Phase
# ==============================================================================

run_build() {
    step_header "Building YetiForge"

    cd "${INSTALL_DIR}" || { log_error "Cannot access ${INSTALL_DIR}"; exit 1; }

    # --- Create data directory ---
    if [[ ! -d "${INSTALL_DIR}/data" ]]; then
        mkdir -p "${INSTALL_DIR}/data"
        log_success "Created data directory"
    fi

    # --- Install server dependencies ---
    log_step "Installing server dependencies..."
    npm install --production=false >> "$INSTALL_LOG" 2>&1 &
    spinner $! "Installing server dependencies..."
    wait $!
    local npm_exit=$?

    if [[ $npm_exit -ne 0 ]]; then
        log_error "npm install failed. Check ${INSTALL_LOG} for details."
        echo ""
        log_info "Last 20 lines of log:"
        tail -20 "$INSTALL_LOG" | while read -r line; do
            echo -e "  ${DIM}${line}${NC}"
        done
        exit 1
    fi
    log_success "Server dependencies installed"

    # --- Install client dependencies ---
    if [[ -f "${INSTALL_DIR}/status/client/package.json" ]]; then
        log_step "Installing dashboard dependencies..."
        cd "${INSTALL_DIR}/status/client" || { log_error "Cannot access status/client"; exit 1; }
        npm install --production=false >> "$INSTALL_LOG" 2>&1 &
        spinner $! "Installing dashboard dependencies..."
        wait $!
        local client_npm_exit=$?

        if [[ $client_npm_exit -ne 0 ]]; then
            log_error "Client npm install failed. Check ${INSTALL_LOG}"
            exit 1
        fi
        log_success "Dashboard dependencies installed"
        cd "${INSTALL_DIR}"
    fi

    # --- Compile TypeScript ---
    log_step "Compiling TypeScript..."
    npx tsc >> "$INSTALL_LOG" 2>&1 &
    spinner $! "Compiling TypeScript..."
    wait $!
    local tsc_exit=$?

    if [[ $tsc_exit -ne 0 ]]; then
        log_error "TypeScript compilation failed."
        echo ""
        log_info "Last 30 lines of log:"
        tail -30 "$INSTALL_LOG" | while read -r line; do
            echo -e "  ${DIM}${line}${NC}"
        done
        exit 1
    fi

    if [[ -f "${INSTALL_DIR}/dist/index.js" ]]; then
        log_success "TypeScript compiled → dist/"
    else
        log_error "Build completed but dist/index.js not found"
        exit 1
    fi

    # --- Build React dashboard ---
    if [[ -f "${INSTALL_DIR}/status/client/package.json" ]]; then
        log_step "Building status dashboard..."
        cd "${INSTALL_DIR}/status/client"
        npm run build >> "$INSTALL_LOG" 2>&1 &
        spinner $! "Building status dashboard..."
        wait $!
        local client_build_exit=$?

        if [[ $client_build_exit -ne 0 ]]; then
            log_error "Dashboard build failed."
            log_info "Last 20 lines of log:"
            tail -20 "$INSTALL_LOG" | while read -r line; do
                echo -e "  ${DIM}${line}${NC}"
            done
            log_warn "Continuing without dashboard — bot will still work"
        else
            if [[ -f "${INSTALL_DIR}/status/client/dist/index.html" ]]; then
                log_success "Dashboard built → status/client/dist/"
            else
                log_warn "Dashboard build completed but index.html not found"
            fi
        fi
        cd "${INSTALL_DIR}"
    fi

    echo ""
    log_success "Build complete"
}
