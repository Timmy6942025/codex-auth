# Codex Auth Automation

Automated OpenAI/Codex account creation using Gmail aliases. Creates new accounts on demand with zero manual intervention.

## How It Works

1. Uses Gmail aliases (`you+codex1@gmail.com`, `you+codex2@gmail.com`, etc.) — all codes land in your real inbox
2. Reads verification codes from Gmail via IMAP
3. Automates the OpenAI OAuth flow with Playwright (headless browser)
4. Captures and stores OAuth tokens directly into `~/.local/share/opencode/auth.json`

## Quick Start

```bash
# Install (auto-installs Chromium)
npm install -g codex-auth-automation

# Setup (interactive)
codex-auth setup

# Create a new account
codex-auth create

# View all accounts
codex-auth status

# Rotate to next account
codex-auth rotate
```

## Setup

### 1. Create a Gmail App Password

1. Go to https://myaccount.google.com/apppasswords
2. Sign in → Search "App Passwords" → Create one
3. Name it something like "codex-auth"
4. Copy the 16-character password

### 2. Run Setup

```bash
codex-auth setup
```

Enter your Gmail address and App Password when prompted.

### 3. Create Accounts

```bash
codex-auth create
```

Each run creates a new account with the next alias (`+codex1`, `+codex2`, etc.).

## Commands

| Command | Description |
|---------|-------------|
| `codex-auth setup` | Interactive setup wizard |
| `codex-auth create` | Create a new Codex account |
| `codex-auth create --alias you+custom@gmail.com` | Create with specific alias |
| `codex-auth status` | Show all accounts with status |
| `codex-auth rotate` | Rotate to next account |
| `codex-auth clean` | Remove expired/invalid accounts |
| `codex-auth config` | View current config |
| `codex-auth config --set headless false` | Show browser during signup |

## Requirements

- Node.js 18+
- Gmail account with App Password enabled
- Chromium (auto-installed via postinstall)

## License

MIT
