import { GmailReader } from './gmail-reader.js';
import { OAuthFlowError, fullBrowserFlow } from './oauth-flow.js';
import { TokenStore, TokenStoreError } from './token-store.js';

export interface AutomationConfig {
  gmailAddr: string;
  gmailAppPassword: string;
  storePath?: string;
  headless?: boolean;
}

export class CodexAuthAutomation {
  private gmail: GmailReader;
  private store: TokenStore;
  private headless: boolean;
  private aliasCounter = 0;

  constructor(config: AutomationConfig) {
    this.gmail = new GmailReader({ email: config.gmailAddr, appPassword: config.gmailAppPassword });
    this.store = new TokenStore(config.storePath);
    this.headless = config.headless ?? true;
  }

  private nextAlias(): string {
    this.aliasCounter += 1;
    const [base, domain] = this.gmail.email.split('@');
    return `${base}+codex${this.aliasCounter}@${domain}`;
  }

  async createAccount(alias?: string): Promise<{ email: string; index: number; tokens: Record<string, unknown> } | null> {
    const targetAlias = alias || this.nextAlias();

    console.log(`[Create] Using alias: ${targetAlias}`);
    console.log('[Create] Starting browser OAuth flow...');

    let tokens: Record<string, unknown>;
    try {
      tokens = await fullBrowserFlow(targetAlias, this.gmail, this.headless);
    } catch (err) {
      console.log(`[Create] OAuth flow failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    let idx: number;
    try {
      idx = this.store.addAccount(tokens, targetAlias);
      console.log(`[Create] Account saved at index ${idx}: ${targetAlias}`);
    } catch (err) {
      console.log(`[Create] Store error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    return { email: targetAlias, index: idx, tokens };
  }

  status(): void {
    const accounts = this.store.listAccounts();
    if (!accounts.length) {
      console.log('No accounts in store.');
      return;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`  Accounts (${accounts.length} total)`);
    console.log('='.repeat(60));

    const nowMs = Date.now();
    const activeIdx = this.store.getActiveAccount()?.index ?? 0;

    for (const acc of accounts) {
      const marker = acc.index === activeIdx ? '>>>' : '   ';
      let status = 'OK';
      if (acc.authInvalid) status = 'AUTH INVALID';
      else if (!acc.enabled) status = 'DISABLED';
      else if (acc.expiresAt < nowMs) status = 'EXPIRED';

      let expiryStr = '';
      if (acc.expiresAt) {
        const expDt = new Date(acc.expiresAt);
        expiryStr = ` (exp: ${expDt.toISOString().replace('T', ' ').slice(0, 16)} UTC)`;
      }

      console.log(`  ${marker} [${acc.index}] ${acc.email}`);
      console.log(`       Status: ${status}${expiryStr} | Usage: ${acc.usageCount}`);
    }

    console.log('='.repeat(60) + '\n');
  }

  rotate(): void {
    const accounts = this.store.listAccounts();
    if (!accounts.length) {
      console.log('No accounts to rotate to.');
      return;
    }

    const current = this.store.getActiveAccount()?.index ?? 0;
    const nextIdx = (current + 1) % accounts.length;

    this.store.setActive(nextIdx);
    const acc = this.store.getAccount(nextIdx);
    if (acc) {
      console.log(`Rotated to account #${nextIdx}: ${acc.email}`);
    } else {
      console.log(`Rotated to account #${nextIdx}`);
    }
  }

  clean(): void {
    const removed = this.store.cleanInvalid();
    console.log(`Removed ${removed} invalid/expired accounts.`);
  }
}
