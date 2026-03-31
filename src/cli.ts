#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodexAuthAutomation } from './automation.js';

const CONFIG_FILE = path.join(os.homedir(), '.config', 'codex-auth', 'config.json');

interface Config {
  gmail: string;
  gmail_app_password: string;
  headless: boolean;
}

function loadConfig(): Config {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return { gmail: '', gmail_app_password: '', headless: true };
}

function saveConfig(config: Config): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function cmdCreate(config: Config, alias?: string) {
  if (!config.gmail || !config.gmail_app_password) {
    console.error('Error: Gmail credentials not configured.');
    console.error('Run: codex-auth setup');
    process.exit(1);
  }

  const app = new CodexAuthAutomation({
    gmailAddr: config.gmail,
    gmailAppPassword: config.gmail_app_password,
    headless: config.headless,
  });

  const result = await app.createAccount(alias);
  if (result) {
    console.log(`\nSuccess! Account created: ${result.email}`);
  } else {
    console.error('\nFailed to create account.');
    process.exit(1);
  }
}

function cmdStatus(config: Config) {
  const app = new CodexAuthAutomation({
    gmailAddr: config.gmail,
    gmailAppPassword: config.gmail_app_password,
  });
  app.status();
}

function cmdRotate(config: Config) {
  const app = new CodexAuthAutomation({
    gmailAddr: config.gmail,
    gmailAppPassword: config.gmail_app_password,
  });
  app.rotate();
}

function cmdClean(config: Config) {
  const app = new CodexAuthAutomation({
    gmailAddr: config.gmail,
    gmailAppPassword: config.gmail_app_password,
  });
  app.clean();
}

function cmdSetup(config: Config) {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => readline.question(prompt, resolve));

  (async () => {
    console.log('codex-auth setup');
    console.log('='.repeat(40));

    const gmail = await question('Gmail address: ');
    const appPw = await question('Gmail App Password: ');
    const headlessInput = await question('Headless mode? (Y/n): ');
    const headless = headlessInput.trim().toLowerCase() !== 'n';

    config.gmail = gmail.trim();
    config.gmail_app_password = appPw.trim();
    config.headless = headless;
    saveConfig(config);

    console.log(`\nConfig saved to ${CONFIG_FILE}`);
    console.log("Run 'codex-auth create' to create your first account.");
    readline.close();
  })();
}

const program = new Command();

program
  .name('codex-auth')
  .description('Automated OpenAI/Codex account creation with Gmail aliases')
  .version('0.1.0');

program
  .command('create')
  .description('Create a new Codex account')
  .option('--alias <alias>', 'Specific alias (e.g. you+custom@gmail.com)')
  .action((opts) => {
    const config = loadConfig();
    cmdCreate(config, opts.alias);
  });

program
  .command('status')
  .description('Show all accounts')
  .action(() => {
    const config = loadConfig();
    cmdStatus(config);
  });

program
  .command('rotate')
  .description('Rotate to next account')
  .action(() => {
    const config = loadConfig();
    cmdRotate(config);
  });

program
  .command('clean')
  .description('Remove invalid/expired accounts')
  .action(() => {
    const config = loadConfig();
    cmdClean(config);
  });

program
  .command('setup')
  .description('Interactive setup wizard')
  .action(() => {
    const config = loadConfig();
    cmdSetup(config);
  });

program
  .command('config')
  .description('View current config')
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

program.parse();
