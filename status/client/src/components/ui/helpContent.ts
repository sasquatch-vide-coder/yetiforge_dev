export interface HelpItem {
  label: string;
  description: string;
}

export interface PanelHelp {
  title: string;
  items: HelpItem[];
}

export const helpContent: Record<string, PanelHelp> = {
  configuration: {
    title: "Configuration Settings",
    items: [
      // Agent Tiers
      {
        label: "Chat Agent Model",
        description:
          "The Claude model used for the chat agent that interprets your messages and decides actions. Haiku = fastest/cheapest, Sonnet = balanced, Opus = most capable.",
      },
      {
        label: "Chat Agent Timeout",
        description:
          "Max seconds the chat agent can run per request. Set to 0 for no timeout.",
      },
      {
        label: "Executor Model",
        description:
          "The Claude model used by the executor agent that runs Claude Code tasks. Opus recommended for complex code work.",
      },
      {
        label: "Executor Timeout",
        description:
          "Max seconds the executor can run per task. Set to 0 for no timeout.",
      },
      // Stall Detection
      {
        label: "Stall Warning Thresholds",
        description:
          "Minutes before a stalled executor triggers a warning alert. Set per complexity: Trivial (quick tasks), Moderate (medium tasks), Complex (large tasks).",
      },
      {
        label: "Stall Kill Thresholds",
        description:
          "Minutes before a stalled executor is forcefully terminated. Must be higher than warning thresholds.",
      },
      {
        label: "Grace Multiplier",
        description:
          "After hitting the kill threshold, the executor gets (kill time x multiplier) as a final grace period before hard abort. Range: 1.0-5.0.",
      },
      // Claude Code
      {
        label: "Claude Code Status",
        description:
          "Shows whether Claude Code CLI is installed, authenticated, and its current version.",
      },
      {
        label: "Plan / Rate Tier",
        description:
          "Your Anthropic subscription plan and API rate limit tier. Determines throughput capacity.",
      },
      {
        label: "Token Expiry",
        description:
          "Time remaining before your Claude Code auth token expires. Re-authenticate via SSH when expired.",
      },
      {
        label: "Check Updates",
        description:
          "Checks npm for a newer Claude Code CLI version. Install directly from the panel if available.",
      },
      // Telegram
      {
        label: "Bot Token",
        description:
          "Your Telegram bot API token from @BotFather. Required for the bot to connect to Telegram.",
      },
      {
        label: "Allowed User IDs",
        description:
          "Comma-separated Telegram user IDs authorized to interact with the bot. Use @userinfobot to find yours.",
      },
      {
        label: "Restart Bot Service",
        description:
          "Restarts the entire bot service. Required after changing the bot token. Brief disconnection expected.",
      },
      // Bot Settings
      {
        label: "Bot Name",
        description:
          "Display name shown in the admin panel header and footer. Cosmetic only — doesn't affect functionality.",
      },
    ],
  },

  security: {
    title: "Security Settings",
    items: [
      // MFA
      {
        label: "Two-Factor Authentication (MFA)",
        description:
          "Adds a TOTP-based second factor to login. Scan the QR code with any authenticator app (Google Authenticator, Authy, etc).",
      },
      {
        label: "MFA Enable / Disable",
        description:
          "Toggle MFA on or off. When enabling, you must verify a 6-digit code first. Disabling removes the requirement immediately.",
      },
      // Username
      {
        label: "Change Username",
        description:
          "Update your admin login username. Must be 3-32 characters, alphanumeric plus dots, hyphens, underscores. Requires confirmation.",
      },
      // Password
      {
        label: "Change Password",
        description:
          "Update your admin password. Requires your current password for verification. Minimum 8 characters.",
      },
      // SSL
      {
        label: "SSL Certificate Status",
        description:
          "Shows whether an SSL/TLS certificate is active, the domain it covers, and its expiration date.",
      },
      {
        label: "Auto-Renew",
        description:
          "When enabled, certificates are automatically renewed before expiry via Let's Encrypt.",
      },
      {
        label: "Renew Now",
        description:
          "Manually trigger an immediate SSL certificate renewal through Let's Encrypt.",
      },
      {
        label: "New Domain",
        description:
          "Generate a new SSL certificate for a different domain. The domain must point to this server's IP first.",
      },
      // Sessions
      {
        label: "Active Sessions",
        description:
          "Lists all currently authenticated admin sessions with IP addresses and expiration times.",
      },
      {
        label: "Revoke Session",
        description:
          "Immediately invalidate a specific session, forcing that device to log in again.",
      },
      {
        label: "Revoke All Others",
        description:
          "Invalidate every session except your current one. Use if you suspect unauthorized access.",
      },
    ],
  },

  monitoring: {
    title: "Monitoring Settings",
    items: [
      // Alerts
      {
        label: "Alerts",
        description:
          "System alerts triggered by events like SSL expiry, bot crashes, high error rates, low disk space, or high memory usage.",
      },
      {
        label: "Alert Severity",
        description:
          "Critical = immediate attention needed. Warning = should investigate soon. Info = awareness only.",
      },
      {
        label: "Acknowledge Alert",
        description:
          "Mark an alert as seen. Acknowledged alerts are dimmed but not deleted — they remain in history.",
      },
      // Audit Log
      {
        label: "Audit Log",
        description:
          "Chronological record of all admin actions: logins, config changes, service restarts, password changes, and more.",
      },
      {
        label: "Action Filter",
        description:
          "Filter audit entries by action type (login_success, config_change, etc.) to narrow down what you're looking for.",
      },
      {
        label: "Locked IPs",
        description:
          "IPs blocked after too many failed login attempts. Unlock manually or wait for the lockout to expire.",
      },
      {
        label: "Unlock IP",
        description:
          "Remove the login lockout for a specific IP address, allowing login attempts again immediately.",
      },
    ],
  },

  maintenance: {
    title: "Maintenance Settings",
    items: [
      {
        label: "Create Backup",
        description:
          "Takes a snapshot of all bot configuration, data, and state files. Stored locally on the server.",
      },
      {
        label: "Backup List",
        description:
          "Shows all existing backups with timestamp, file count, and total size.",
      },
      {
        label: "Restore Backup",
        description:
          "Overwrites current configuration and data with a previous backup. Use with caution — this replaces live data.",
      },
      {
        label: "Delete Backup",
        description:
          "Permanently removes a backup from the server. Cannot be undone.",
      },
    ],
  },
};
