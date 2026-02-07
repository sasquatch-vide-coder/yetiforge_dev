#!/usr/bin/env bash
# ==============================================================================
# YetiForge Installer — SSL Certificate Setup (Let's Encrypt)
# ==============================================================================

setup_ssl() {
    step_header "SSL Certificate (Optional)"

    # Skip if no domain
    if [[ "$HAS_DOMAIN" != "true" ]] || [[ -z "$CFG_DOMAIN" ]]; then
        log_info "No domain configured — skipping SSL setup"
        log_info "You can set up SSL later with: sudo certbot --nginx -d yourdomain.com"
        return 0
    fi

    # Check if certbot is available
    if ! command -v certbot &> /dev/null; then
        log_warn "Certbot not available — skipping SSL"
        log_info "Install certbot later and run: sudo certbot --nginx -d ${CFG_DOMAIN}"
        return 0
    fi

    # Check if cert already exists
    if [[ -d "/etc/letsencrypt/live/${CFG_DOMAIN}" ]]; then
        log_success "SSL certificate already exists for ${CFG_DOMAIN}"
        return 0
    fi

    echo ""
    echo -e "  ${DIM}SSL will secure your dashboard with HTTPS using Let's Encrypt.${NC}"
    echo -e "  ${DIM}Your domain (${CFG_DOMAIN}) must already point to this server.${NC}"
    echo ""

    prompt_yn "Set up free SSL certificate for ${CFG_DOMAIN}?" "y" SETUP_SSL_NOW

    if [[ "$SETUP_SSL_NOW" != "true" ]]; then
        log_info "Skipping SSL — you can set it up later:"
        log_info "  sudo certbot --nginx -d ${CFG_DOMAIN}"
        return 0
    fi

    # Prompt for email
    prompt_with_default "Email for SSL certificate notifications" "" CFG_SSL_EMAIL false

    local certbot_flags="--nginx -d ${CFG_DOMAIN} --non-interactive --agree-tos"
    if [[ -n "$CFG_SSL_EMAIL" ]]; then
        certbot_flags="${certbot_flags} --email ${CFG_SSL_EMAIL}"
    else
        certbot_flags="${certbot_flags} --register-unsafely-without-email"
    fi

    log_step "Requesting SSL certificate..."
    if $SUDO_CMD certbot ${certbot_flags} >> "$INSTALL_LOG" 2>&1; then
        log_success "SSL certificate installed for ${CFG_DOMAIN}"

        # Set up auto-renewal
        if ! $SUDO_CMD crontab -l 2>/dev/null | grep -q "certbot renew"; then
            ($SUDO_CMD crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | $SUDO_CMD crontab -
            log_success "Auto-renewal cron job configured (daily at 3 AM)"
        else
            log_success "Auto-renewal already configured"
        fi

        SSL_CONFIGURED=true
    else
        log_warn "SSL setup failed — dashboard will work over HTTP"
        log_info "Common causes: domain not pointing to this server, port 80 blocked"
        log_info "Try manually: sudo certbot --nginx -d ${CFG_DOMAIN}"
        SSL_CONFIGURED=false
    fi

    echo ""
}
