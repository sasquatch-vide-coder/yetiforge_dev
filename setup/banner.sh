#!/usr/bin/env bash
# ==============================================================================
# YetiForge Installer — Banner & UI Helpers
# ==============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Symbols
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
ARROW="${CYAN}→${NC}"
WARN="${YELLOW}⚠${NC}"
INFO="${BLUE}ℹ${NC}"

# Step counter
CURRENT_STEP=0
TOTAL_STEPS=7

show_banner() {
    clear
    echo -e "${CYAN}"
    cat << 'BANNER'

    ██╗   ██╗███████╗████████╗██╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗
    ╚██╗ ██╔╝██╔════╝╚══██╔══╝██║██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
     ╚████╔╝ █████╗     ██║   ██║█████╗  ██║   ██║██████╔╝██║  ███╗█████╗
      ╚██╔╝  ██╔══╝     ██║   ██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
       ██║   ███████╗   ██║   ██║██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
       ╚═╝   ╚══════╝   ╚═╝   ╚═╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝

BANNER
    echo -e "${NC}"
    echo -e "    ${WHITE}${BOLD}AI-Powered Telegram Bot Framework${NC}"
    echo -e "    ${DIM}One-command deployment • Production-ready • Open source${NC}"
    echo ""
    echo -e "    ${DIM}────────────────────────────────────────────────────────${NC}"
    echo ""
}

step_header() {
    CURRENT_STEP=$((CURRENT_STEP + 1))
    echo ""
    echo -e "  ${BOLD}${WHITE}[$CURRENT_STEP/$TOTAL_STEPS]${NC} ${BOLD}$1${NC}"
    echo -e "  ${DIM}$(printf '%.0s─' $(seq 1 60))${NC}"
}

log_info() {
    echo -e "  ${INFO}  $1"
}

log_success() {
    echo -e "  ${CHECK}  $1"
}

log_warn() {
    echo -e "  ${WARN}  $1"
}

log_error() {
    echo -e "  ${CROSS}  ${RED}$1${NC}"
}

log_step() {
    echo -e "  ${ARROW}  $1"
}

# Spinner for long-running operations
spinner() {
    local pid=$1
    local msg=$2
    local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        local c=${spin:i++%${#spin}:1}
        printf "\r  ${CYAN}${c}${NC}  ${msg}" >&2
        sleep 0.1
    done
    printf "\r" >&2
}

# Prompt with default value
prompt_with_default() {
    local prompt_text="$1"
    local default_val="$2"
    local var_name="$3"
    local required="${4:-false}"

    while true; do
        if [[ -n "$default_val" ]]; then
            echo -en "  ${ARROW}  ${prompt_text} ${DIM}[${default_val}]${NC}: "
        else
            echo -en "  ${ARROW}  ${prompt_text}: "
        fi
        read -r input
        local value="${input:-$default_val}"

        if [[ "$required" == "true" && -z "$value" ]]; then
            log_error "This field is required. Please enter a value."
            continue
        fi

        eval "$var_name='$value'"
        break
    done
}

# Yes/No prompt
prompt_yn() {
    local prompt_text="$1"
    local default="${2:-y}"
    local var_name="$3"

    local hint="Y/n"
    [[ "$default" == "n" ]] && hint="y/N"

    echo -en "  ${ARROW}  ${prompt_text} ${DIM}[${hint}]${NC}: "
    read -r input
    input="${input:-$default}"
    input=$(echo "$input" | tr '[:upper:]' '[:lower:]')

    if [[ "$input" == "y" || "$input" == "yes" ]]; then
        eval "$var_name=true"
    else
        eval "$var_name=false"
    fi
}

# Secret prompt (no echo)
prompt_secret() {
    local prompt_text="$1"
    local var_name="$2"
    local required="${3:-true}"

    while true; do
        echo -en "  ${ARROW}  ${prompt_text}: "
        read -rs input
        echo ""

        if [[ "$required" == "true" && -z "$input" ]]; then
            log_error "This field is required. Please enter a value."
            continue
        fi

        eval "$var_name='$input'"
        break
    done
}

# Display a box with content
show_box() {
    local title="$1"
    shift
    local width=64

    echo ""
    echo -e "  ${CYAN}╔$(printf '═%.0s' $(seq 1 $width))╗${NC}"
    echo -e "  ${CYAN}║${NC}  ${BOLD}${WHITE}${title}$(printf ' %.0s' $(seq 1 $((width - ${#title} - 2))))${NC}${CYAN}║${NC}"
    echo -e "  ${CYAN}╠$(printf '═%.0s' $(seq 1 $width))╣${NC}"
    for line in "$@"; do
        local clean_line
        clean_line=$(echo -e "$line" | sed 's/\x1b\[[0-9;]*m//g')
        local padding=$((width - ${#clean_line} - 2))
        [[ $padding -lt 0 ]] && padding=0
        echo -e "  ${CYAN}║${NC}  ${line}$(printf ' %.0s' $(seq 1 $padding))${CYAN}║${NC}"
    done
    echo -e "  ${CYAN}╚$(printf '═%.0s' $(seq 1 $width))╝${NC}"
    echo ""
}

# Error handler
handle_error() {
    local exit_code=$1
    local line_no=$2
    local command="$3"

    if [[ $exit_code -ne 0 ]]; then
        echo ""
        log_error "Installation failed at line ${line_no}"
        log_error "Command: ${command}"
        log_error "Exit code: ${exit_code}"
        echo ""
        log_info "Check the log file for details: ${INSTALL_LOG:-/tmp/yetiforge-install.log}"
        log_info "You can re-run the installer after fixing the issue."
        echo ""
        exit $exit_code
    fi
}
