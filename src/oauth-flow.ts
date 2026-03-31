import { chromium, Browser, BrowserContext, Page } from 'playwright';
import http from 'http';
import crypto from 'crypto';
import url from 'url';
import path from 'path';
import fs from 'fs';
import { GmailReader } from './gmail-reader.js';

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke'];
const REDIRECT_PORT = 1455;
const DEBUG_DIR = path.join(process.cwd(), 'debug');

function generatePkce() {
  const raw = crypto.randomBytes(32);
  const codeVerifier = raw.toString('base64url');
  const digest = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = digest.toString('base64url');
  return { codeVerifier, codeChallenge };
}

function generateState() {
  return crypto.randomBytes(32).toString('base64url');
}

function buildAuthUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `http://localhost:${REDIRECT_PORT}/auth/callback`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function startCallbackServer(): Promise<{ code: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url || '', true);
      const code = parsed.query.code as string | undefined;

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Login successful!</h1><p>Close this window.</p>');
        server.close(() => resolve({ code, server }));
      } else {
        res.writeHead(400);
        res.end('No code found.');
      }
    });

    server.listen(REDIRECT_PORT);
    server.on('error', reject);
  });
}

async function exchangeCode(code: string, codeVerifier: string): Promise<Record<string, any>> {
  const data = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `http://localhost:${REDIRECT_PORT}/auth/callback`,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new OAuthFlowError(`Token exchange failed (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }

  return resp.json() as Promise<Record<string, any>>;
}

async function findElement(page: Page, selectors: string[], timeout = 10000) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout });
      if (el) return el;
    } catch { }
  }
  throw new OAuthFlowError(`Element not found. Tried: ${selectors.join(', ')}. URL: ${page.url()}`);
}

async function handleConsent(page: Page) {
  try {
    const btn = await page.$('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Authorize"), button:has-text("Accept")');
    if (btn) {
      const text = await btn.innerText();
      console.log(`  Clicking: '${text.trim()}'`);
      await btn.click();
      await page.waitForTimeout(2000);
    }
  } catch {
    // No consent page
  }
}

async function saveScreenshot(page: Page, name: string) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filePath = path.join(DEBUG_DIR, `${name}_${Date.now()}.png`);
    await page.screenshot({ path: filePath });
    console.log(`  Screenshot: ${filePath}`);
  } catch {
    // Screenshot failed, non-critical
  }
}

function generatePassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  let pw = '';
  for (let i = 0; i < 16; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

export async function browserSignup(
  email: string,
  gmailReader: GmailReader,
  headless = true,
): Promise<Record<string, any>> {
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();
  const authUrl = buildAuthUrl(codeChallenge, state);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let server: http.Server | null = null;

  try {
    browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });
    
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    `);
    
    page = await context.newPage();
    
    console.log('  [0/6] Warming up browser...');
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(1000);

    console.log('  [1/6] Navigating to OpenAI auth...');
    console.log('  URL:', authUrl);
    await page.goto(authUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);
    await saveScreenshot(page, 'after_nav');

    console.log(`  [2/6] Entering email: ${email}...`);
    const emailInput = await findElement(page, [
      'input[name="email"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[placeholder*="email" i]',
    ]);
    await emailInput.fill(email);
    await page.waitForTimeout(500);

    const contBtn = await findElement(page, [
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Next")',
    ]);
    await contBtn.click();
    await page.waitForTimeout(5000);

    console.log('  [3/6] Detecting page state...');
    await saveScreenshot(page, 'page_state');

    const signUpLink = await page.$('a:has-text("Sign up"), button:has-text("Sign up"), a:has-text("Create account"), button:has-text("Create account")');
    if (signUpLink) {
      console.log('  [3/6] Found Sign up link — clicking...');
      await signUpLink.click();
      await page.waitForTimeout(5000);
    }

    const otpLink = await page.$('button:has-text("one-time code"), a:has-text("one-time code")');
    const hasCodeInput = await page.$('input[name="code"], input[inputmode="numeric"]');
    const hasPasswordInput = await page.$('input[type="password"]');
    const hasEmailInput = await page.$('input[name="email"], input[name="username"], input[type="email"]');

    if (hasEmailInput && !otpLink && !hasCodeInput) {
      console.log('  [3/6] Email input found — entering email...');
      await hasEmailInput.fill(email);
      await page.waitForTimeout(500);
      const btn = await page.$('button[type="submit"], button:has-text("Continue")');
      if (btn) { await btn.click(); await page.waitForTimeout(5000); }
    }

    const otpLink2 = await page.$('button:has-text("one-time code"), a:has-text("one-time code")');
    const hasCodeInput2 = await page.$('input[name="code"], input[inputmode="numeric"]');
    const hasPasswordInput2 = await page.$('input[type="password"]');

    if (otpLink2 || hasCodeInput2) {
      if (otpLink2) {
        console.log('  [3/6] Clicking one-time code...');
        await otpLink2.click();
        await page.waitForTimeout(3000);
        const otpEmailInput = await page.$('input[name="email"], input[type="email"]');
        if (otpEmailInput) {
          await otpEmailInput.fill(email);
          await page.waitForTimeout(300);
          const submit = await page.$('button[type="submit"], button:has-text("Continue")');
          if (submit) { await submit.click(); await page.waitForTimeout(2000); }
        }
      }

      console.log('  [4/6] Waiting for verification email...');
      const otpCode = await gmailReader.searchForCode(email, 90000, 3000);
      if (!otpCode) throw new OAuthFlowError('No OTP code received');
      console.log(`  [4/6] Got OTP code: ${otpCode}`);

      const codeField = await findElement(page, ['input[name="code"]', 'input[inputmode="numeric"]'], 10000);
      await codeField.fill(otpCode);
      await page.waitForTimeout(500);
      const verifyBtn = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Verify")']);
      await verifyBtn.click();
      await page.waitForTimeout(5000);

    } else if (hasPasswordInput2) {
      console.log('  [3/6] Account creation — setting password...');
      const password = generatePassword();
      await hasPasswordInput2.fill(password);
      await page.waitForTimeout(500);
      const confirmPw = await page.$('input[name="confirmPassword"], input[name="confirm_password"]');
      if (confirmPw) await confirmPw.fill(password);
      const submitBtn = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Create")']);
      await submitBtn.click();
      await page.waitForTimeout(5000);

      console.log('  [4/6] Waiting for verification email...');
      const otpCode = await gmailReader.searchForCode(email, 90000, 3000);
      if (!otpCode) throw new OAuthFlowError('No verification code received');
      console.log(`  [4/6] Got verification code: ${otpCode}`);

      const codeField = await findElement(page, ['input[name="code"]', 'input[inputmode="numeric"]', 'input[type="text"]'], 10000);
      await codeField.fill(otpCode);
      await page.waitForTimeout(500);
      const verifyBtn = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Verify")']);
      await verifyBtn.click();
      await page.waitForTimeout(5000);

    } else {
      await saveScreenshot(page, 'unknown_state');
      throw new OAuthFlowError(`Cannot determine page state. URL: ${page.url()}`);
    }

    console.log('  [5/6] Handling consent page...');
    await page.waitForTimeout(2000);
    await saveScreenshot(page, 'before_consent');
    await handleConsent(page);
    await page.waitForTimeout(1000);
    await saveScreenshot(page, 'after_consent');

    console.log('  [6/6] Starting callback server and waiting for OAuth code...');
    console.log('  Current URL:', page.url());
    
    const callbackPromise = startCallbackServer();
    const callbackWithTimeout = Promise.race([
      callbackPromise,
      new Promise<{ code: string; server: http.Server }>((_, reject) =>
        setTimeout(() => reject(new Error('OAuth callback timeout (60s)')), 60000)
      ),
    ]);
    
    const { code, server: callbackServer } = await callbackWithTimeout;
    server = callbackServer;
    console.log(`  Got OAuth code: ${code.slice(0, 20)}...`);

    console.log('  Exchanging code for tokens...');
    const tokens = await exchangeCode(code, codeVerifier);
    return tokens;
  } catch (err) {
    if (page) {
      await saveScreenshot(page, 'browser_signup_error');
    }
    if (browser) {
      await browser.close();
    }
    if (server) {
      try { server.close(); } catch {}
    }
    throw new OAuthFlowError(`Browser signup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function fullBrowserFlow(
  email: string,
  gmailReader: GmailReader,
  headless = true,
): Promise<Record<string, any>> {
  console.log('[Browser Flow] Starting OAuth flow...');
  const tokens = await browserSignup(email, gmailReader, headless);
  console.log(`[Browser Flow] Tokens received for ${email}`);
  return tokens;
}
