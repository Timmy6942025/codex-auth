import { chromium, Browser, BrowserContext, Page } from 'playwright';
import http from 'http';
import crypto from 'crypto';
import url from 'url';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { GmailReader } from './gmail-reader.js';

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

class PythonFallbackSuccess extends Error {
  constructor(public readonly oauthCode: string, public readonly password: string | null) {
    super('Python fallback succeeded');
    this.name = 'PythonFallbackSuccess';
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

async function waitForCloudflareChallenge(page: Page, maxWait = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const title = await page.title();
    const bodyText = await page.$eval('body', el => el.textContent || '').catch(() => '');

    if (title.includes('Just a moment') || bodyText.includes('Just a moment') || bodyText.includes('Checking your browser')) {
      console.log('  Cloudflare challenge detected, waiting...');
      await page.waitForTimeout(8000);
      continue;
    }

    if (bodyText.includes('Unexpected token') || (bodyText.includes('storageKey') && title.includes('Oops'))) {
      console.log('  React crash detected, page is broken');
      return false;
    }

    if (title.includes('OpenAI') || title.includes('ChatGPT') || await page.$('input[name="email"], input[name="username"], input[type="email"]')) {
      return true;
    }

    await page.waitForTimeout(1000);
  }
  return false;
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

async function isCloudflareChallenge(page: Page): Promise<boolean> {
  const title = await page.title();
  const bodyText = await page.$eval('body', el => el.textContent || '').catch(() => '');
  return title.includes('Just a moment') || bodyText.includes('Just a moment') || bodyText.includes('Checking your browser');
}

async function createBrowserContext(headless: boolean): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  const context = await browser.newContext({
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
  
  const page = await context.newPage();
  return { browser, context, page };
}

async function runPythonFallback(
  targetEmail: string,
  gmailReader: GmailReader,
  codeChallenge: string,
  state: string,
  headless: boolean,
): Promise<{ oauthCode: string; password: string | null }> {
  const scriptPath = path.join(process.cwd(), 'scripts', 'browser_automation.py');
  const args = [
    scriptPath,
    targetEmail,
    gmailReader.email,
    gmailReader.getAppPassword(),
  ];
  if (headless) args.push('--headless');
  args.push('--code-challenge', codeChallenge);
  args.push('--state', state);

  return new Promise((resolve, reject) => {
    const python = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      python.kill();
      reject(new OAuthFlowError('Python script timed out after 300 seconds'));
    }, 300000);
    python.stdout.on('data', (data) => { stdout += data.toString(); });
    python.stderr.on('data', (data) => { stderr += data.toString(); });
    python.on('error', (err) => {
      clearTimeout(timeout);
      reject(new OAuthFlowError(`Failed to spawn Python: ${err.message}`));
    });
    python.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new OAuthFlowError(`Python script failed with code ${code}: ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.success) {
          reject(new OAuthFlowError(`Python script error: ${result.error}`));
          return;
        }
        if (!result.oauth_code) {
          reject(new OAuthFlowError('Python script did not return oauth_code'));
          return;
        }
        resolve({ oauthCode: result.oauth_code, password: result.password });
      } catch (err) {
        reject(new OAuthFlowError(`Failed to parse Python script output: ${err}`));
      }
    });
  });
}

async function signupViaChatGPT(page: Page, email: string, gmailReader: GmailReader, codeChallenge: string, state: string, headless: boolean): Promise<{ url: string; oauthCode?: string; password?: string }> {
  console.log('  Navigating to chatgpt.com...');
  await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const navOk = await waitForCloudflareChallenge(page);
  if (!navOk) {
    const isCF = await isCloudflareChallenge(page);
    if (isCF) {
      console.log('  Cloudflare challenge detected, falling back to Python script');
      const result = await runPythonFallback(email, gmailReader, codeChallenge, state, headless);
      throw new PythonFallbackSuccess(result.oauthCode, result.password);
    }
    console.log('  Cloudflare challenge not resolved, page may be broken');
  }
  await saveScreenshot(page, 'chatgpt_home');
  
  console.log('  Looking for signup/login buttons...');
  
  const signupButtons = await page.$$('button, a');
  for (const btn of signupButtons) {
    const text = (await btn.textContent().catch(() => '')) || '';
    if (/sign\s*up|log\s*in|get\s*started|try\s*chatgpt/i.test(text)) {
      console.log(`  Found button: "${text.trim()}"`);
      try {
        await btn.click();
        await page.waitForTimeout(3000);
        const loginNavOk = await waitForCloudflareChallenge(page);
        if (!loginNavOk) {
          console.log('  Cloudflare challenge after login click not resolved');
        }
        break;
      } catch { }
    }
  }
  
  await page.waitForTimeout(2000);
  await saveScreenshot(page, 'after_signup_click');
  
  console.log('  Filling email...');
  const emailInput = await findElement(page, [
    'input[name="email"]',
    'input[name="username"]',
    'input[type="email"]',
    'input[placeholder*="email" i]',
    'input[aria-label*="Email" i]',
    'input[aria-label*="email" i]',
    'input[placeholder*="Email" i]',
  ], 15000);
  await emailInput.fill(email);
  await page.waitForTimeout(500);
  
  const contBtn = await findElement(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
  ], 10000);
  await contBtn.click();
  await page.waitForTimeout(5000);
  const emailNavOk = await waitForCloudflareChallenge(page);
  if (!emailNavOk) {
    console.log('  Cloudflare challenge after email submit not resolved');
  }
  await saveScreenshot(page, 'after_email_submit');
  
  const afterSubmitUrl = page.url();
  const afterSubmitTitle = await page.title();
  console.log(`  After email submit - URL: ${afterSubmitUrl}, Title: ${afterSubmitTitle}`);
  
  // Wait for Turnstile to potentially load
  await page.waitForTimeout(5000);
  
  // Try to find and click Turnstile checkbox
  // The Turnstile widget is typically in an iframe from challenges.cloudflare.com
  console.log('  Looking for Turnstile iframe...');
  
  const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare"], iframe[title*="Widget"], iframe[src*="turnstile"]');
  
  try {
    // Try to click the checkbox within the iframe
    const checkbox = turnstileFrame.locator('input[type="checkbox"], .cb-lb, label');
    await checkbox.first().click({ timeout: 5000 });
    console.log('  Clicked Turnstile checkbox in iframe');
  } catch {
    // If that fails, try clicking the iframe itself at checkbox coordinates
    console.log('  Iframe checkbox not found, trying coordinate click...');
    
    // Find all iframes and log them
    const iframes = await page.$$('iframe');
    console.log(`  Found ${iframes.length} iframes`);
    
    for (const iframe of iframes) {
      const src = await iframe.getAttribute('src').catch(() => '');
      const box = await iframe.boundingBox().catch(() => null);
      console.log(`  iframe src=${(src || '').slice(0, 80)}, box=${JSON.stringify(box)}`);
      
      if (box && (src?.includes('challenge') || src?.includes('turnstile') || src?.includes('cloudflare'))) {
        // Click at the checkbox position (left side of widget, vertically centered)
        const clickX = box.x + 20;
        const clickY = box.y + box.height / 2;
        console.log(`  Clicking Turnstile at (${clickX}, ${clickY})`);
        await page.mouse.click(clickX, clickY);
        await page.waitForTimeout(8000);
        await saveScreenshot(page, 'after_turnstile_click');
      }
    }
    
    // If no iframes found, try clicking at approximate screen coordinates
    if (iframes.length === 0) {
      console.log('  No iframes found, clicking at approximate checkbox position...');
      await page.mouse.click(500, 440);
      await page.waitForTimeout(8000);
      await saveScreenshot(page, 'after_coord_click');
    }
  }
  
  await page.waitForTimeout(3000);
  const afterCaptchaUrl = page.url();
  console.log(`  After CAPTCHA attempt - URL: ${afterCaptchaUrl}`);
  
  if (afterSubmitUrl.includes('/error') || afterSubmitTitle.includes('Oops')) {
    console.log('  Error page detected after email, retrying...');
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const retryNavOk = await waitForCloudflareChallenge(page);
    if (!retryNavOk) {
      console.log('  Cloudflare challenge after retry nav not resolved');
    }
    
    const loginBtn2 = await page.$('button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign in"), a:has-text("Sign in")');
    if (loginBtn2) {
      await loginBtn2.click();
      await page.waitForTimeout(3000);
      const loginNavOk2 = await waitForCloudflareChallenge(page);
      if (!loginNavOk2) {
        console.log('  Cloudflare challenge after login click retry not resolved');
      }
    }
    
    const emailInput2 = await findElement(page, [
      'input[name="email"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[aria-label*="Email" i]',
    ], 15000);
    await emailInput2.fill(email);
    await page.waitForTimeout(500);
    const contBtn2 = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 10000);
    await contBtn2.click();
    await page.waitForTimeout(5000);
    const retryEmailNavOk = await waitForCloudflareChallenge(page);
    if (!retryEmailNavOk) {
      console.log('  Cloudflare challenge after email retry submit not resolved');
    }
    await saveScreenshot(page, 'after_email_retry');
  }
  
  await page.waitForTimeout(3000);
  
  const hasPasswordInput = await page.$('input[type="password"]');
  const hasOtpLink = await page.$('button:has-text("one-time code"), a:has-text("one-time code"), button:has-text("email code"), a:has-text("email code")');
  const hasCodeInput = await page.$('input[name="code"], input[inputmode="numeric"], input[autocomplete="one-time-code"]');
  
  if (hasPasswordInput) {
    console.log('  Password setup detected...');
    const password = generatePassword();
    await hasPasswordInput.fill(password);
    await page.waitForTimeout(500);
    const confirmPw = await page.$('input[name="confirmPassword"], input[name="confirm_password"]');
    if (confirmPw) await confirmPw.fill(password);
    const submitBtn = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Create")']);
    await submitBtn.click();
    await page.waitForTimeout(5000);
    await saveScreenshot(page, 'after_password');
  }
  
  if (hasOtpLink) {
    console.log('  OTP link detected, clicking...');
    await hasOtpLink.click();
    await page.waitForTimeout(3000);
    const otpEmailInput = await page.$('input[name="email"], input[type="email"]');
    if (otpEmailInput) {
      await otpEmailInput.fill(email);
      await page.waitForTimeout(300);
      const submit = await page.$('button[type="submit"], button:has-text("Continue")');
      if (submit) { await submit.click(); await page.waitForTimeout(2000); }
    }
  }
  
  console.log('  Waiting for verification code...');
  const otpCode = await gmailReader.searchForCode(email, 90000, 3000);
  if (!otpCode) throw new OAuthFlowError('No verification code received');
  console.log(`  Got verification code: ${otpCode}`);
  
  await page.waitForTimeout(2000);
  
  console.log('  Looking for code input field...');
  const codeSelectors = [
    'input[name="code"]',
    'input[inputmode="numeric"]',
    'input[autocomplete="one-time-code"]',
    'input[type="text"]',
    'input[aria-label*="code" i]',
    'input[aria-label*="Code" i]',
    'input[placeholder*="code" i]',
  ];
  
  let codeField = null;
  for (const sel of codeSelectors) {
    try {
      codeField = await page.waitForSelector(sel, { timeout: 5000 });
      if (codeField) break;
    } catch { }
  }
  
  if (!codeField) {
    const currentUrl = page.url();
    const currentTitle = await page.title();
    const bodyText = (await page.$eval('body', el => el.textContent || '').catch(() => '')).slice(0, 300);
    const allInputs = await page.$$eval('input', els => els.map(el => ({
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
    })));
    console.log(`  Current URL: ${currentUrl}`);
    console.log(`  Current title: ${currentTitle}`);
    console.log(`  Body text: ${bodyText}`);
    console.log(`  All inputs: ${JSON.stringify(allInputs)}`);
    await saveScreenshot(page, 'no_code_field');
    throw new OAuthFlowError(`Code input field not found. URL: ${currentUrl}`);
  }
  await codeField.fill(otpCode);
  await page.waitForTimeout(500);
  const verifyBtn = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Verify")']);
  await verifyBtn.click();
  await page.waitForTimeout(5000);
  await saveScreenshot(page, 'after_code_entry');
  
  await page.waitForTimeout(3000);
  
  const nameInput = await page.$('input[name="name"], input[name="full_name"], input[aria-label*="name" i], input[placeholder*="name" i]');
  if (nameInput) {
    console.log('  Name input found, filling...');
    await nameInput.fill('Test User');
    await page.waitForTimeout(500);
    const nameSubmit = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")']);
    await nameSubmit.click();
    await page.waitForTimeout(5000);
    await saveScreenshot(page, 'after_name');
  }
  
  const birthdayInput = await page.$('input[name="birthday"], input[aria-label*="birthday" i], input[aria-label*="birth" i], input[aria-label*="month" i]');
  if (birthdayInput) {
    console.log('  Birthday input found, filling...');
    const monthStr = '01';
    const dayStr = '15';
    const yearStr = '1990';
    const birthdayStr = `${monthStr}${dayStr}${yearStr}`;
    
    const monthSpin = await page.$('[role="spinbutton"][aria-label*="month" i]');
    if (monthSpin) {
      await monthSpin.click();
      await page.waitForTimeout(300);
      await page.keyboard.type(birthdayStr, { delay: 100 });
    } else {
      await birthdayInput.fill(birthdayStr);
    }
    await page.waitForTimeout(500);
    const bdaySubmit = await findElement(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")', 'button:has-text("Submit")']);
    await bdaySubmit.click();
    await page.waitForTimeout(5000);
    await saveScreenshot(page, 'after_birthday');
  }
  
  await handleConsent(page);
  await page.waitForTimeout(3000);
  await saveScreenshot(page, 'after_signup');
  
  const currentUrl = page.url();
  console.log(`  Signup complete, current URL: ${currentUrl}`);
  
  return { url: currentUrl };
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
    console.log('  [0/6] Launching browser...');
    ({ browser, context, page } = await createBrowserContext(headless));
    
    console.log('  [1/6] Creating account via chatgpt.com...');
    await signupViaChatGPT(page, email, gmailReader, codeChallenge, state, headless);
    
    console.log('  [2/6] Navigating to OAuth authorize URL...');
    console.log('  URL:', authUrl);
    
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    const navOk = await waitForCloudflareChallenge(page);
    if (!navOk) {
      console.log('  Auth URL still failing, retrying...');
      await page.waitForTimeout(3000);
      await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitForCloudflareChallenge(page, 15000);
    }
    
    await page.waitForTimeout(3000);
    await saveScreenshot(page, 'after_auth_nav');
    
    console.log('  Current URL:', page.url());
    console.log('  Page title:', await page.title());
    
    if (page.url().includes('localhost') || page.url().includes('127.0.0.1')) {
      console.log('  Already redirected to callback!');
      const parsed = url.parse(page.url(), true);
      const code = parsed.query.code as string | undefined;
      if (code) {
        console.log(`  Got OAuth code from URL: ${code.slice(0, 20)}...`);
        console.log('  Exchanging code for tokens...');
        const tokens = await exchangeCode(code, codeVerifier);
        return tokens;
      }
    }
    
    await handleConsent(page);
    await page.waitForTimeout(3000);
    await saveScreenshot(page, 'after_consent');
    
    console.log('  [3/6] Starting callback server and waiting for OAuth code...');
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
    if (err instanceof PythonFallbackSuccess) {
      // Python fallback succeeded, exchange code for tokens
      console.log('  Python fallback succeeded, using OAuth code');
      const tokens = await exchangeCode(err.oauthCode, codeVerifier);
      // Close browser and server before returning
      if (browser) await browser.close();
      if (server) try { server.close(); } catch {}
      return tokens;
    }
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
