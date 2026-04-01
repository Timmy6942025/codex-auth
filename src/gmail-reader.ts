import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { Readable } from 'stream';

export class GmailReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailReaderError';
  }
}

export interface GmailConfig {
  email: string;
  appPassword: string;
}

export class GmailReader {
  readonly email: string;
  private appPassword: string;
  private conn: Imap | null = null;

  private static CODE_PATTERNS = [
    /verification code[:\s]+(\d{6})/i,
    /your code is[:\s]*(\d{6})/i,
    /enter this code[:\s]+(\d{6})/i,
    /your verification code is (\d{6})/i,
    /code[:\s]+(\d{6})/i,
    /\b(\d{6})\b/,
  ];

  constructor(config: GmailConfig) {
    this.email = config.email;
    this.appPassword = config.appPassword;
  }

  getAppPassword(): string {
    return this.appPassword;
  }

  connect(): Promise<Imap> {
    return new Promise((resolve, reject) => {
      const conn = new Imap({
        user: this.email,
        password: this.appPassword.replace(/\s/g, ''),
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
      });

      conn.once('ready', () => {
        this.conn = conn;
        resolve(conn);
      });

      conn.once('error', (err) => {
        reject(new GmailReaderError(`IMAP login failed: ${err.message}`));
      });

      conn.connect();
    });
  }

  private async ensureConnected(): Promise<Imap> {
    if (!this.conn) {
      return this.connect();
    }
    return this.conn;
  }

  async searchForCode(
    alias: string,
    timeout = 60000,
    pollInterval = 3000,
  ): Promise<string | null> {
    const conn = await this.ensureConnected();
    const deadline = Date.now() + timeout;
    const seenUids = new Set<string>();
    const targetAliasLower = alias.toLowerCase();
    const targetBaseEmail = alias.split('+')[0].toLowerCase() + '@';

    while (Date.now() < deadline) {
      try {
        const messages = await this.searchImap(conn, seenUids);
        messages.sort((a, b) => Number(b.uid) - Number(a.uid));

        for (const msg of messages) {
          if (seenUids.has(msg.uid)) continue;
          seenUids.add(msg.uid);

          const { body, recipient } = await this.fetchMessageWithRecipient(conn, msg.uid);
          const recipientLower = recipient.toLowerCase();
          const isAddressedToAlias = recipientLower.includes(targetAliasLower) ||
                                     recipientLower.startsWith(targetBaseEmail);

          if (isAddressedToAlias) {
            const code = this.extractCode(body);
            if (code) return code;
          }
        }
      } catch (e) {
        // transient error, keep polling
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(pollInterval, remaining));
    }

    return null;
  }

  async getLatestCode(): Promise<{ code: string; recipient: string } | null> {
    const conn = await this.ensureConnected();

    return new Promise((resolve, reject) => {
      conn.openBox('INBOX', true, (err) => {
        if (err) return reject(new GmailReaderError(`Failed to open inbox: ${err.message}`));

        conn.search([['FROM', 'openai.com']], (err, results) => {
          if (err || !results || results.length === 0) return resolve(null);

          const uids = results.slice(-10);
          const fetch = conn.fetch(uids, { bodies: '' });

          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(Readable.from(stream))
                .then((parsed) => {
                  const body = parsed.text || parsed.html || '';
                  const code = this.extractCode(String(body));
                  if (code) {
                    const toText = parsed.to
                      ? (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text)
                      : '';
                    resolve({ code, recipient: String(toText || '') });
                  }
                })
                .catch(() => {});
            });
          });

          fetch.once('error', reject);
          fetch.once('end', () => resolve(null));
        });
      });
    });
  }

  close(): void {
    if (this.conn) {
      try { this.conn.end(); } catch { }
      this.conn = null;
    }
  }

  private searchImap(
    conn: Imap,
    seenUids: Set<string>,
  ): Promise<{ uid: string }[]> {
    return new Promise((resolve, reject) => {
      conn.openBox('INBOX', true, (err) => {
        if (err) return reject(new GmailReaderError(`Failed to open inbox: ${err.message}`));

        conn.search([['FROM', 'openai.com']], (err, results) => {
          if (err) return reject(new GmailReaderError(`Search failed: ${err.message}`));
          if (!results || results.length === 0) return resolve([]);

          resolve(
            results.map((uid) => ({ uid: String(uid) })).filter((m) => !seenUids.has(m.uid)),
          );
        });
      });
    });
  }

  private fetchMessageBody(conn: Imap, uid: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const fetch = conn.fetch(uid, { bodies: '' });

      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(Readable.from(stream))
            .then((parsed) => {
              resolve(String(parsed.text || parsed.html || ''));
            })
            .catch(reject);
        });
        msg.once('error', reject);
      });

      fetch.once('error', reject);
      fetch.once('end', () => resolve(''));
    });
  }

  private fetchMessageWithRecipient(conn: Imap, uid: string): Promise<{ body: string; recipient: string }> {
    return new Promise((resolve, reject) => {
      const fetch = conn.fetch(uid, { bodies: ['HEADER', 'TEXT'] });

      let headerData = '';
      let bodyData = '';

      fetch.on('message', (msg) => {
        msg.on('body', (stream, info) => {
          if (info.which === 'HEADER') {
            stream.on('data', (chunk) => { headerData += chunk.toString('utf8'); });
          } else {
            stream.on('data', (chunk) => { bodyData += chunk.toString('utf8'); });
          }
        });
        msg.once('error', reject);
        msg.once('end', () => {
          const toMatch = headerData.match(/\r?\nTo:\s*([^\r\n]+)/i);
          const recipient = toMatch ? toMatch[1].trim() : '';
          resolve({ body: bodyData, recipient });
        });
      });

      fetch.once('error', reject);
      fetch.once('end', () => {
        if (!headerData && !bodyData) {
          resolve({ body: '', recipient: '' });
        }
      });
    });
  }

  private extractCode(content: string): string | null {
    if (!content) return null;

    for (const pattern of GmailReader.CODE_PATTERNS) {
      const match = pattern.exec(content);
      if (match && !match[1].startsWith('20')) {
        return match[1];
      }
    }

    const allCodes = content.match(/\b(\d{6})\b/g);
    if (allCodes) {
      const valid = allCodes.filter((c) => !c.startsWith('20'));
      if (valid.length > 0) return valid[valid.length - 1];
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
