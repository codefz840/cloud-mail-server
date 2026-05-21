'use strict';

/**
 * SMTP server that bridges outgoing mail to the cloud-mail API.
 *
 * The server uses the `smtp-server` package (nodemailer project) for the
 * SMTP protocol layer and `mailparser` to decode incoming messages.
 *
 * Flow:
 *   1. Email client connects and authenticates (AUTH PLAIN / LOGIN).
 *   2. Server validates credentials against the cloud-mail /login endpoint.
 *   3. Email client submits the message (MAIL FROM / RCPT TO / DATA).
 *   4. Server parses the raw MIME message and calls /email/send on cloud-mail.
 */

const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const CloudMailClient = require('../api/cloud-mail-client');
const { extractAccountAddresses } = require('../utils/account-addresses');

class SmtpBridgeServer {
  /**
   * @param {string} cloudMailUrl  Base URL of the cloud-mail worker
   */
  constructor(cloudMailUrl) {
    this.cloudMailUrl = cloudMailUrl;

    this.server = new SMTPServer({
      // Allow plain-text auth (clients connect locally; TLS can be added later)
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],

      // Authenticate against cloud-mail
      onAuth: (auth, session, callback) => this._onAuth(auth, session, callback),

      // Accept any RCPT TO address (routing is handled by cloud-mail)
      onRcptTo: (address, session, callback) => callback(),

      // Process incoming email data
      onData: (stream, session, callback) => this._onData(stream, session, callback),

      logger: false,
    });

    this.server.on('error', err => {
      console.error('[SMTP] server error:', err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // AUTH
  // ---------------------------------------------------------------------------

  async _onAuth(auth, session, callback) {
    const username = auth.username;
    const password = auth.password;

    if (!username || !password) {
      return callback(new Error('Username and password required'));
    }

    try {
      const client = new CloudMailClient(this.cloudMailUrl);
      await client.login(username, password);
      // Store the authenticated client on the session for use in _onData
      session.cloudMailClient = client;
      session.username = username;
      callback(null, { user: username });
    } catch (err) {
      callback(new Error('Authentication failed: ' + err.message));
    }
  }

  // ---------------------------------------------------------------------------
  // DATA
  // ---------------------------------------------------------------------------

  _findAccountByAddress(accounts, fromAddress) {
    const sender = String(fromAddress || '').trim().toLowerCase();
    if (!Array.isArray(accounts) || accounts.length === 0) return null;
    if (!sender) return accounts[0];

    return accounts.find(account =>
      extractAccountAddresses(account).some(addr => addr.toLowerCase() === sender)
    ) || accounts[0];
  }

  async _onData(stream, session, callback) {
    let rawEmail;
    try {
      rawEmail = await this._readStream(stream);
    } catch (err) {
      return callback(new Error('Failed to read message: ' + err.message));
    }

    let parsed;
    try {
      parsed = await simpleParser(rawEmail);
    } catch (err) {
      return callback(new Error('Failed to parse message: ' + err.message));
    }

    const client = session.cloudMailClient;
    if (!client || !client.token) {
      return callback(new Error('Not authenticated'));
    }

    try {
      // Resolve the accountId for the MAIL FROM address
      const fromAddress = session.envelope && session.envelope.mailFrom
        ? session.envelope.mailFrom.address
        : session.username;

      const accounts = await client.listAccounts();
      const account = this._findAccountByAddress(accounts, fromAddress);

      if (!account) {
        return callback(new Error('No matching account found for sender ' + fromAddress));
      }

      // Build the recipient list from RCPT TO
      const rcptTo = (session.envelope && session.envelope.rcptTo) || [];
      const receiveEmail = rcptTo.length > 0
        ? rcptTo.map(r => r.address)
        : (parsed.to ? parsed.to.value.map(a => a.address) : []);

      if (receiveEmail.length === 0) {
        return callback(new Error('No recipients'));
      }

      const subject = parsed.subject || '';
      const text = parsed.text || '';
      // Use html content if available and non-empty, otherwise fall back to plain text
      const content = (parsed.html && parsed.html.trim()) ? parsed.html : text;

      await client.sendEmail({
        accountId: account.accountId,
        name: account.name || fromAddress,
        receiveEmail,
        subject,
        text,
        content,
        attachments: [],
      });

      callback(); // success
    } catch (err) {
      console.error('[SMTP] sendEmail failed:', err.message);
      callback(new Error('Message delivery failed: ' + err.message));
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _readStream(stream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start listening.
   * @param {number} port
   * @param {string} host
   * @returns {Promise<void>}
   */
  listen(port, host) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ port, host }, () => {
        console.log(`[SMTP] listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  close() {
    return new Promise(resolve => this.server.close(resolve));
  }
}

module.exports = SmtpBridgeServer;
