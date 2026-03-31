import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenStoreError';
  }
}

export interface Account {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId?: string;
  expiresAt: number;
  email: string;
  lastRefresh: string;
  lastSeenAt: number;
  addedAt: number;
  source: string;
  authInvalid: boolean;
  usageCount: number;
  enabled: boolean;
  quota: unknown;
  rateLimitHistory?: unknown[];
}

export interface StoreData {
  version: number;
  accounts: Account[];
  activeIndex: number;
  rotationIndex: number;
  lastRotation: number;
}

function defaultStore(): StoreData {
  return {
    version: 2,
    accounts: [],
    activeIndex: 0,
    rotationIndex: 0,
    lastRotation: Date.now(),
  };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

function getExpiryFromClaims(claims: Record<string, unknown> | null): number | null {
  if (!claims) return null;
  const exp = claims.exp;
  if (typeof exp === 'number') return Math.floor(exp * 1000);
  return null;
}

function getAccountId(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  if (auth && typeof auth.chatgpt_account_id === 'string') return auth.chatgpt_account_id;
  return null;
}

export class TokenStore {
  private storePath: string;
  private store: StoreData;

  constructor(storePath?: string) {
    this.storePath = storePath || path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.config',
      'opencode',
      'codex-automation-accounts.json',
    );
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.store = this.load();
  }

  get path(): string {
    return this.storePath;
  }

  private load(): StoreData {
    if (!fs.existsSync(this.storePath)) return defaultStore();
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      if (typeof data !== 'object' || !Array.isArray(data.accounts)) return defaultStore();
      return {
        version: data.version || 2,
        accounts: data.accounts,
        activeIndex: data.activeIndex ?? 0,
        rotationIndex: data.rotationIndex ?? 0,
        lastRotation: data.lastRotation ?? Date.now(),
      };
    } catch {
      return defaultStore();
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    if (fs.existsSync(this.storePath)) {
      fs.copyFileSync(this.storePath, this.storePath + '.bak');
    }
    const tmpPath = `${this.storePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2));
    fs.renameSync(tmpPath, this.storePath);
    fs.chmodSync(this.storePath, 0o600);
  }

  addAccount(tokens: Record<string, unknown>, email: string): number {
    const nowMs = Date.now();
    const nowIso = new Date().toISOString();

    const accessClaims = decodeJwt(String(tokens.access_token || ''));
    const idClaims = decodeJwt(String(tokens.id_token || ''));

    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
    const expiresAt = getExpiryFromClaims(accessClaims)
      || getExpiryFromClaims(idClaims)
      || nowMs + (expiresIn as number) * 1000;

    const accountId = getAccountId(accessClaims) || getAccountId(idClaims);

    const newAccount: Account = {
      accessToken: String(tokens.access_token || ''),
      refreshToken: String(tokens.refresh_token || ''),
      idToken: String(tokens.id_token || ''),
      accountId: accountId || undefined,
      expiresAt,
      email,
      lastRefresh: nowIso,
      lastSeenAt: nowMs,
      addedAt: nowMs,
      source: 'opencode',
      authInvalid: false,
      usageCount: 0,
      enabled: true,
      quota: null,
    };

    const existingIdx = this.store.accounts.findIndex((a) => a.email === email);
    if (existingIdx >= 0) {
      const old = this.store.accounts[existingIdx];
      this.store.accounts[existingIdx] = {
        ...old,
        ...newAccount,
        usageCount: old.usageCount,
        addedAt: old.addedAt,
        rateLimitHistory: old.rateLimitHistory,
      };
      this.save();
      return existingIdx;
    }

    this.store.accounts.push(newAccount);
    const idx = this.store.accounts.length - 1;
    if (this.store.activeIndex < 0) this.store.activeIndex = idx;
    this.save();
    return idx;
  }

  getAccount(index: number): Account | null {
    return this.store.accounts[index] || null;
  }

  getActiveAccount(): { index: number; account: Account } | null {
    const idx = this.store.activeIndex;
    const accounts = this.store.accounts;
    if (!accounts.length) return null;

    for (let offset = 0; offset < accounts.length; offset++) {
      const i = (idx + offset) % accounts.length;
      const acc = accounts[i];
      if (acc.enabled && !acc.authInvalid) return { index: i, account: acc };
    }
    return null;
  }

  setActive(index: number): void {
    if (index >= 0 && index < this.store.accounts.length) {
      this.store.activeIndex = index;
      this.save();
    }
  }

  removeAccount(index: number): void {
    if (index >= 0 && index < this.store.accounts.length) {
      this.store.accounts.splice(index, 1);
      if (this.store.activeIndex >= this.store.accounts.length) {
        this.store.activeIndex = Math.max(0, this.store.accounts.length - 1);
      }
      if (this.store.accounts.length > 0) this.save();
    }
  }

  listAccounts(): Array<{ index: number; email: string; enabled: boolean; authInvalid: boolean; expiresAt: number; usageCount: number; quota: unknown }> {
    return this.store.accounts.map((acc, i) => ({
      index: i,
      email: acc.email,
      enabled: acc.enabled,
      authInvalid: acc.authInvalid,
      expiresAt: acc.expiresAt,
      usageCount: acc.usageCount,
      quota: acc.quota,
    }));
  }

  cleanInvalid(): number {
    const nowMs = Date.now();
    const originalCount = this.store.accounts.length;
    this.store.accounts = this.store.accounts.filter(
      (acc) => !acc.authInvalid && acc.expiresAt > nowMs,
    );
    const removed = originalCount - this.store.accounts.length;
    if (removed > 0) {
      if (this.store.accounts.length > 0) {
        this.store.activeIndex = Math.min(this.store.activeIndex, this.store.accounts.length - 1);
      } else {
        this.store.activeIndex = 0;
      }
      this.save();
    }
    return removed;
  }

  updateAccount(index: number, updates: Partial<Account>): void {
    if (index >= 0 && index < this.store.accounts.length) {
      Object.assign(this.store.accounts[index], updates);
      this.save();
    }
  }
}
