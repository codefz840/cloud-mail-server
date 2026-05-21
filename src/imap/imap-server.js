'use strict';

/**
 * IMAP4rev1 server (RFC 3501) that bridges to the cloud-mail API.
 *
 * Supported commands:
 *   CAPABILITY, NOOP, LOGOUT, LOGIN, AUTHENTICATE, LIST, LSUB,
 *   SELECT, EXAMINE, STATUS, FETCH, UID FETCH, STORE, UID STORE,
 *   COPY, UID COPY, MOVE, UID MOVE,
 *   EXPUNGE, SEARCH, UID SEARCH, CLOSE
 *
 * Supported AUTHENTICATE mechanisms:
 *   PLAIN
 *
 * Supported FETCH items:
 *   FLAGS, UID, INTERNALDATE, RFC822.SIZE, RFC822, RFC822.HEADER,
 *   RFC822.TEXT, ENVELOPE, BODY, BODYSTRUCTURE,
 *   BODY[], BODY[HEADER], BODY[TEXT], BODY[HEADER.FIELDS (...)],
 *   BODY.PEEK[...] (same as BODY[...] but without \Seen)
 *
 * Folder structure exposed to clients:
 *   INBOX  → cloud-mail type=0 (received emails)
 *   Sent   → cloud-mail type=1 (sent emails)
 *   Trash  → session-local virtual trash (cloud-mail has no native trash)
 *            COPY/MOVE to Trash stores emails in memory for the session.
 *            EXPUNGE on Trash permanently deletes via the API.
 *            COPY/MOVE between INBOX and Sent is not supported.
 *
 * Known limitations:
 *   - SEARCH criteria are not evaluated; all messages are always returned.
 *   - IDLE is acknowledged but does not push live updates; clients must
 *     re-SELECT or poll to discover new messages.
 *   - Only CRLF line endings are accepted from clients (RFC 3501 §2.2).
 *   - No TLS support built-in; use a TLS reverse-proxy for encrypted access.
 */

const net = require('net');
const {
  buildMime,
  extractHeaders,
  extractBody,
  buildEnvelope,
  buildBodyStructure,
} = require('../utils/mime-builder');
const CloudMailClient = require('../api/cloud-mail-client');
const { extractAccountAddresses } = require('../utils/account-addresses');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPABILITIES = 'IMAP4rev1 LITERAL+ UIDPLUS IDLE MOVE SPECIAL-USE AUTH=PLAIN';

/** Map built-in IMAP folder aliases to canonical mailbox descriptors */
const BUILTIN_MAILBOX_MAP = {
  INBOX: { key: 'INBOX', name: 'INBOX', type: 0 },
  SENT: { key: 'SENT', name: 'Sent', type: 1 },
  'SENT MESSAGES': { key: 'SENT', name: 'Sent', type: 1 },
  'SENT ITEMS': { key: 'SENT', name: 'Sent', type: 1 },
  TRASH: { key: 'TRASH', name: 'Trash', type: 'trash' },
  'DELETED ITEMS': { key: 'TRASH', name: 'Trash', type: 'trash' },
  'DELETED MESSAGES': { key: 'TRASH', name: 'Trash', type: 'trash' },
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for use inside an IMAP quoted string.
 * @param {string} s
 * @returns {string}
 */
function q(s) {
  return '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Produce an IMAP literal: {N}\r\n<data>
 * @param {string|Buffer} data
 * @returns {string}
 */
function literal(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
  return `{${buf.length}}\r\n` + buf.toString('binary');
}

/**
 * Parse an IMAP sequence set (e.g. "1", "1:3", "1,3:5,7") into an array of
 * individual numbers, relative to the messages array length.
 * @param {string} set
 * @param {number} total  Total number of messages in mailbox
 * @returns {number[]}  1-based sequence numbers
 */
function parseSequenceSet(set, total) {
  const result = new Set();
  const parts = set.split(',');
  for (const part of parts) {
    if (part.includes(':')) {
      let [lo, hi] = part.split(':').map(v => (v === '*' ? total : parseInt(v, 10)));
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let i = lo; i <= hi; i++) result.add(i);
    } else {
      const n = part === '*' ? total : parseInt(part, 10);
      result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Parse a UID set into an array of UIDs.
 * @param {string} set
 * @param {number[]} uids  All UIDs in the mailbox (sorted ascending)
 * @returns {number[]}
 */
function parseUidSet(set, uids) {
  const maxUid = uids.length > 0 ? Math.max(...uids) : 0;
  const result = new Set();
  const parts = set.split(',');
  for (const part of parts) {
    if (part.includes(':')) {
      let [lo, hi] = part.split(':').map(v => (v === '*' ? maxUid : parseInt(v, 10)));
      if (lo > hi) [lo, hi] = [hi, lo];
      for (const uid of uids) {
        if (uid >= lo && uid <= hi) result.add(uid);
      }
    } else {
      const uid = part === '*' ? maxUid : parseInt(part, 10);
      if (uids.includes(uid)) result.add(uid);
    }
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Parse IMAP parenthesised list of fetch items, e.g.:
 *   "(FLAGS UID RFC822.SIZE)"  →  ['FLAGS', 'UID', 'RFC822.SIZE']
 *   "FLAGS"                   →  ['FLAGS']
 * Also handles macro shortcuts: ALL, FULL, FAST.
 * @param {string} raw
 * @returns {string[]}
 */
function parseFetchItems(raw) {
  if (!raw) return [];
  const s = raw.trim();

  const macros = {
    ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
    FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'],
    FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
  };
  if (macros[s.toUpperCase()]) return macros[s.toUpperCase()];

  // Strip surrounding parens if present
  const inner = s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;

  // Tokenise: split on spaces but keep BODY[...] together
  const items = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === ' ') { i++; continue; }
    const bracketStart = inner.indexOf('[', i);
    const nextSpace = inner.indexOf(' ', i);

    if (bracketStart !== -1 && (nextSpace === -1 || bracketStart < nextSpace)) {
      // token contains [...]
      const bracketEnd = inner.indexOf(']', bracketStart);
      if (bracketEnd !== -1) {
        items.push(inner.slice(i, bracketEnd + 1).toUpperCase());
        i = bracketEnd + 1;
        // optional <partial>
        if (inner[i] === '<') {
          const pe = inner.indexOf('>', i);
          i = pe !== -1 ? pe + 1 : i + 1;
        }
        continue;
      }
    }

    const end = nextSpace === -1 ? inner.length : nextSpace;
    items.push(inner.slice(i, end).toUpperCase());
    i = end;
  }
  return items;
}

/**
 * Decode IMAP AUTHENTICATE PLAIN initial response or continuation payload.
 * Payload decodes to: authzid\0authcid\0passwd
 * @param {string} encoded
 * @returns {{username: string, password: string}|null}
 */
function decodeAuthPlain(encoded) {
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const parts = decoded.split('\u0000');
    if (parts.length < 3) return null;
    const username = parts[1] || '';
    const password = parts.slice(2).join('\u0000');
    if (!username || !password) return null;
    return { username, password };
  } catch (_) {
    return null;
  }
}

function parseMailboxName(raw) {
  const s = String(raw || '').trim();
  const quoted = s.match(/^"([^"]+)"$/);
  return (quoted ? quoted[1] : s).trim();
}

// ---------------------------------------------------------------------------
// ImapSession
// ---------------------------------------------------------------------------

class ImapSession {
  constructor(socket, cloudMailUrl) {
    this.socket = socket;
    this.cloudMailUrl = cloudMailUrl;
    this.client = new CloudMailClient(cloudMailUrl);

    /** NOT_AUTHENTICATED | AUTHENTICATED | SELECTED | LOGOUT */
    this.state = 'NOT_AUTHENTICATED';
    this.readOnly = false;

    /** Cached messages for the currently selected mailbox */
    this.messages = [];

    /** Set of UIDs to be expunged (STORE \Deleted) */
    this.pendingDeletes = new Set();

    /** cloud-mail type for selected folder (0=INBOX, 1=Sent, 'trash') */
    this.selectedType = null;
    this.selectedMailboxKey = null;

    /**
     * Session-local Trash store.
     * Holds email objects that were COPY'd or MOVE'd to Trash within this
     * session.  cloud-mail has no native trash; we keep the copies in memory.
     */
    this.trashMessages = [];

    /**
     * Tracks emailIds present in trashMessages that were COPY'd (not MOVE'd),
     * meaning the API copy still exists and must be deleted when Trash is
     * EXPUNGE'd or when the source folder is EXPUNGE'd.
     */
    this._trashApiIds = new Set();

    this._buffer = '';
    this._authContinuation = null;
    /** Tag saved when entering IDLE state, used to send the tagged OK on DONE */
    this._idleTag = null;

    socket.setEncoding('utf8');
    socket.on('data', (data) => this._onData(data));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') {
        console.error('[IMAP] socket error:', err.message);
      }
    });

    this._send('* OK IMAP4rev1 cloud-mail-server ready');
  }

  // -------------------------------------------------------------------------
  // Low-level I/O
  // -------------------------------------------------------------------------

  _send(line) {
    if (this.socket.writable) {
      this.socket.write(line + '\r\n');
    }
  }

  _ok(tag, msg) { this._send(`${tag} OK ${msg}`); }
  _no(tag, msg) { this._send(`${tag} NO ${msg}`); }
  _bad(tag, msg) { this._send(`${tag} BAD ${msg}`); }

  async _listAddressMailboxes() {
    let accounts = [];
    try {
      accounts = await this.client.listAccounts();
    } catch (err) {
      console.error('[IMAP] listAccounts failed:', err.message);
    }

    const seen = new Set();
    const dynamic = [];
    for (const account of accounts) {
      if (!account || account.accountId == null) continue;
      for (const addr of extractAccountAddresses(account)) {
        const mailbox = `INBOX/${addr}`;
        const key = mailbox.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        dynamic.push({ key, name: mailbox, type: 0, accountId: account.accountId });
      }
    }

    dynamic.sort((a, b) => a.name.localeCompare(b.name));
    return dynamic;
  }

  async _resolveMailbox(mailboxName) {
    const normalized = parseMailboxName(mailboxName);
    if (!normalized) return null;

    const upper = normalized.toUpperCase();
    const builtin = BUILTIN_MAILBOX_MAP[upper];
    if (builtin) return builtin;

    if (!upper.startsWith('INBOX/')) return null;
    const dynamic = await this._listAddressMailboxes();
    return dynamic.find(box => box.key === upper) || null;
  }

  async _buildListMailboxes() {
    const dynamic = await this._listAddressMailboxes();
    const inboxAttrs = dynamic.length > 0 ? '(\\HasChildren)' : '(\\HasNoChildren)';
    const list = [
      { attrs: inboxAttrs, name: 'INBOX' },
      ...dynamic.map(box => ({ attrs: '(\\HasNoChildren)', name: box.name })),
      { attrs: '(\\HasNoChildren \\Sent)', name: 'Sent' },
      { attrs: '(\\HasNoChildren \\Trash)', name: 'Trash' },
    ];
    return list;
  }

  _onData(data) {
    this._buffer += data;
    // IMAP (RFC 3501 §2.2) mandates CRLF line endings from clients.
    // We split on CRLF here; a bare LF from a non-conformant client
    // will remain in the buffer until the next CRLF arrives.
    const lines = this._buffer.split('\r\n');
    this._buffer = lines.pop(); // incomplete line stays in buffer

    for (const line of lines) {
      if (line.length === 0) continue;
      this._dispatch(line).catch(err => {
        console.error('[IMAP] unhandled error:', err);
      });
    }
  }

  _onClose() {
    // nothing to clean up for now
  }

  // -------------------------------------------------------------------------
  // Command dispatch
  // -------------------------------------------------------------------------

  async _dispatch(line) {
    if (this._authContinuation) {
      const handler = this._authContinuation;
      this._authContinuation = null;
      await handler(line);
      return;
    }

    // Handle IDLE DONE: bare "DONE" with no tag (RFC 2177 §3)
    if (line.trim().toUpperCase() === 'DONE') {
      if (this._idleTag) {
        this._ok(this._idleTag, 'IDLE terminated');
        this._idleTag = null;
      }
      return;
    }

    // IMAP command: TAG COMMAND [args...]
    const m = line.match(/^(\S+)\s+(\S+)(.*)?$/);
    if (!m) { this._send('* BAD Invalid command'); return; }

    const tag = m[1];
    const command = m[2].toUpperCase();
    const rest = (m[3] || '').trim();

    console.log(`[IMAP] C: ${line}`);

    try {
      switch (command) {
        case 'CAPABILITY': this._cmdCapability(tag); break;
        case 'NOOP':       this._ok(tag, 'NOOP completed'); break;
        case 'LOGOUT':     await this._cmdLogout(tag); break;
        case 'LOGIN':      await this._cmdLogin(tag, rest); break;
        case 'AUTHENTICATE': await this._cmdAuthenticate(tag, rest); break;
        case 'LIST':       await this._cmdList(tag, rest); break;
        case 'LSUB':       await this._cmdLsub(tag, rest); break;
        case 'SELECT':     await this._cmdSelect(tag, rest, false); break;
        case 'EXAMINE':    await this._cmdSelect(tag, rest, true); break;
        case 'STATUS':     await this._cmdStatus(tag, rest); break;
        case 'FETCH':      await this._cmdFetch(tag, rest, false); break;
        case 'STORE':      await this._cmdStore(tag, rest, false); break;
        case 'COPY':       await this._cmdCopy(tag, rest, false); break;
        case 'MOVE':       await this._cmdMove(tag, rest, false); break;
        case 'EXPUNGE':    await this._cmdExpunge(tag); break;
        case 'SEARCH':     this._cmdSearch(tag, rest); break;
        case 'CLOSE':      await this._cmdClose(tag); break;
        case 'UID': {
          const sub = rest.match(/^(\S+)(.*)?$/);
          if (!sub) { this._bad(tag, 'Missing UID sub-command'); break; }
          const subCmd = sub[1].toUpperCase();
          const subArgs = (sub[2] || '').trim();
          switch (subCmd) {
            case 'FETCH':   await this._cmdFetch(tag, subArgs, true); break;
            case 'STORE':   await this._cmdStore(tag, subArgs, true); break;
            case 'COPY':    await this._cmdCopy(tag, subArgs, true); break;
            case 'MOVE':    await this._cmdMove(tag, subArgs, true); break;
            case 'EXPUNGE': await this._cmdUidExpunge(tag, subArgs); break;
            case 'SEARCH':  this._cmdSearch(tag, subArgs, true); break;
            default: this._bad(tag, `Unknown UID sub-command: ${subCmd}`);
          }
          break;
        }
        case 'IDLE': {
          // Minimal IDLE: acknowledge and wait for DONE (RFC 2177)
          this._idleTag = tag;
          this._send('+ idling');
          // We don't push new mail; the client will re-SELECT periodically
          break;
        }
        default:
          this._bad(tag, `Command not supported: ${command}`);
      }
    } catch (err) {
      console.error(`[IMAP] error in ${command}:`, err.message);
      this._no(tag, `${command} failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY
  // -------------------------------------------------------------------------

  _cmdCapability(tag) {
    this._send(`* CAPABILITY ${CAPABILITIES}`);
    this._ok(tag, 'CAPABILITY completed');
  }

  // -------------------------------------------------------------------------
  // LOGOUT
  // -------------------------------------------------------------------------

  async _cmdLogout(tag) {
    this._send('* BYE cloud-mail-server logging out');
    this._ok(tag, 'LOGOUT completed');
    this.state = 'LOGOUT';
    try { await this.client.logout(); } catch (_) {}
    this.socket.end();
  }

  // -------------------------------------------------------------------------
  // LOGIN / AUTHENTICATE
  // -------------------------------------------------------------------------

  async _authenticateWithCredentials(tag, username, password, successMessage) {
    if (this.state !== 'NOT_AUTHENTICATED') {
      this._no(tag, 'Already authenticated');
      return;
    }

    try {
      await this.client.login(username, password);
      this.state = 'AUTHENTICATED';
      console.log(`[IMAP] authenticated: ${username}`);
      this._ok(tag, successMessage);
    } catch (err) {
      console.error(`[IMAP] authentication failed for ${username}:`, err.message);
      this._no(tag, `${successMessage.split(' ')[0]} failed: ${err.message}`);
    }
  }

  async _cmdLogin(tag, args) {
    // LOGIN "user@example.com" "password"  OR  LOGIN user password
    const m = args.match(/^"([^"]+)"\s+"([^"]+)"$/) ||
              args.match(/^(\S+)\s+(\S+)$/) ||
              args.match(/^"([^"]+)"\s+(\S+)$/) ||
              args.match(/^(\S+)\s+"([^"]+)"$/);

    if (!m) {
      this._bad(tag, 'Syntax: LOGIN user password');
      return;
    }

    const username = m[1];
    const password = m[2];
    await this._authenticateWithCredentials(tag, username, password, 'LOGIN completed');
  }

  async _cmdAuthenticate(tag, args) {
    if (this.state !== 'NOT_AUTHENTICATED') {
      this._no(tag, 'Already authenticated');
      return;
    }

    const parts = args.split(/\s+/).filter(Boolean);
    const mechanism = (parts[0] || '').toUpperCase();
    const initialResponse = parts[1] || null;

    if (mechanism !== 'PLAIN') {
      this._no(tag, `Unsupported authentication mechanism: ${mechanism || '(missing)'}`);
      return;
    }

    const finishPlain = async (encoded) => {
      if (encoded === '*') {
        this._bad(tag, 'AUTHENTICATE cancelled');
        return;
      }

      const creds = decodeAuthPlain(encoded);
      if (!creds) {
        this._bad(tag, 'Invalid AUTHENTICATE PLAIN payload');
        return;
      }

      await this._authenticateWithCredentials(tag, creds.username, creds.password, 'AUTHENTICATE completed');
    };

    if (initialResponse) {
      await finishPlain(initialResponse);
      return;
    }

    this._authContinuation = finishPlain;
    this._send('+');
  }

  // -------------------------------------------------------------------------
  // LIST / LSUB
  // -------------------------------------------------------------------------

  async _cmdList(tag, args) {
    if (this.state === 'NOT_AUTHENTICATED') {
      this._no(tag, 'Not authenticated');
      return;
    }

    const mailboxes = await this._buildListMailboxes();
    for (const mailbox of mailboxes) {
      this._send(`* LIST ${mailbox.attrs} "/" ${q(mailbox.name)}`);
    }
    this._ok(tag, 'LIST completed');
  }

  async _cmdLsub(tag) {
    if (this.state === 'NOT_AUTHENTICATED') {
      this._no(tag, 'Not authenticated');
      return;
    }

    const mailboxes = await this._buildListMailboxes();
    for (const mailbox of mailboxes) {
      this._send(`* LSUB ${mailbox.attrs} "/" ${q(mailbox.name)}`);
    }
    this._ok(tag, 'LSUB completed');
  }

  // -------------------------------------------------------------------------
  // SELECT / EXAMINE
  // -------------------------------------------------------------------------

  async _cmdSelect(tag, args, readOnly) {
    if (this.state === 'NOT_AUTHENTICATED') {
      this._no(tag, 'Not authenticated');
      return;
    }

    const mailbox = await this._resolveMailbox(args);
    if (!mailbox) {
      this._no(tag, `Mailbox does not exist: ${args}`);
      return;
    }

    this.state = 'SELECTED';
    this.readOnly = readOnly;
    this.selectedType = mailbox.type;
    this.selectedMailboxKey = mailbox.key;
    this.pendingDeletes.clear();

    // Fetch emails from cloud-mail (or use session-local Trash store)
    if (mailbox.type === 'trash') {
      this.messages = [...this.trashMessages];
    } else {
      this.messages = await this.client.fetchAllEmails(mailbox.type, 500, {
        accountId: mailbox.accountId,
      });
      // Ensure oldest-to-newest order (ascending emailId) for IMAP sequence numbers
      this.messages.sort((a, b) => a.emailId - b.emailId);
    }

    const total = this.messages.length;
    const unseen = this.messages.filter(m => m.unread === 0).length;
    const uidValidity = 1; // fixed; we don't need to change mailboxes
    const uidNext = total > 0 ? this.messages[total - 1].emailId + 1 : 1;

    this._send(`* ${total} EXISTS`);
    this._send(`* 0 RECENT`);
    if (unseen > 0) {
      // Find the first unseen message's sequence number
      const firstUnseen = this.messages.findIndex(m => m.unread === 0) + 1;
      this._send(`* OK [UNSEEN ${firstUnseen}] First unseen message`);
    }
    this._send(`* OK [PERMANENTFLAGS (\\Deleted \\Seen \\Answered \\Flagged \\*)] Permanent flags`);
    this._send(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid`);
    this._send(`* OK [UIDNEXT ${uidNext}] Predicted next UID`);
    this._send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`);

    const mode = readOnly ? '[READ-ONLY]' : '[READ-WRITE]';
    this._ok(tag, `${mode} SELECT completed`);
  }

  // -------------------------------------------------------------------------
  // STATUS
  // -------------------------------------------------------------------------

  async _cmdStatus(tag, args) {
    if (this.state === 'NOT_AUTHENTICATED') {
      this._no(tag, 'Not authenticated');
      return;
    }

    const m = args.match(/^"([^"]+)"\s+\(([^)]+)\)\s*$/) ||
              args.match(/^(\S+)\s+\(([^)]+)\)\s*$/);
    if (!m) { this._bad(tag, 'Syntax: STATUS mailbox (items)'); return; }

    const mailbox = await this._resolveMailbox(m[1]);
    if (!mailbox) {
      this._no(tag, `No such mailbox: ${m[1]}`);
      return;
    }

    let messages;
    if (this.selectedMailboxKey === mailbox.key) {
      messages = this.messages;
    } else if (mailbox.type === 'trash') {
      messages = this.trashMessages;
    } else {
      messages = await this.client.fetchAllEmails(mailbox.type, 500, {
        accountId: mailbox.accountId,
      });
    }

    const total = messages.length;
    const unseen = messages.filter(m => m.unread === 0).length;
    const uidNext = total > 0 ? Math.max(...messages.map(m => m.emailId)) + 1 : 1;

    const itemList = m[2].toUpperCase().split(/\s+/);
    const statusParts = itemList.map(item => {
      switch (item) {
        case 'MESSAGES':  return `MESSAGES ${total}`;
        case 'RECENT':    return `RECENT 0`;
        case 'UNSEEN':    return `UNSEEN ${unseen}`;
        case 'UIDNEXT':   return `UIDNEXT ${uidNext}`;
        case 'UIDVALIDITY': return `UIDVALIDITY 1`;
        default: return '';
      }
    }).filter(Boolean).join(' ');

    this._send(`* STATUS ${q(m[1])} (${statusParts})`);
    this._ok(tag, 'STATUS completed');
  }

  // -------------------------------------------------------------------------
  // FETCH / UID FETCH
  // -------------------------------------------------------------------------

  async _cmdFetch(tag, args, byUid) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }

    const m = args.match(/^(\S+)\s+(.+)$/s);
    if (!m) { this._bad(tag, 'Syntax: FETCH sequence items'); return; }

    const seqOrUidSet = m[1];
    const itemsRaw = m[2].trim();
    const items = parseFetchItems(itemsRaw);

    const total = this.messages.length;

    let targets; // {seqNum, msg} pairs
    if (byUid) {
      const uids = this.messages.map(msg => msg.emailId);
      const requestedUids = parseUidSet(seqOrUidSet, uids);
      targets = requestedUids.map(uid => {
        const idx = this.messages.findIndex(m => m.emailId === uid);
        return idx !== -1 ? { seqNum: idx + 1, msg: this.messages[idx] } : null;
      }).filter(Boolean);
    } else {
      const seqNums = parseSequenceSet(seqOrUidSet, total);
      targets = seqNums
        .filter(n => n >= 1 && n <= total)
        .map(n => ({ seqNum: n, msg: this.messages[n - 1] }));
    }

    // Determine if this fetch should auto-mark as seen
    const implicitSeen = items.some(it =>
      it === 'RFC822' || it === 'RFC822.TEXT' || it === 'BODY[]' ||
      it === 'BODY[TEXT]' || it === 'BODY'
    ) && !itemsRaw.toUpperCase().includes('BODY.PEEK');

    // Track which messages should be marked as read
    const toMarkRead = [];

    for (const { seqNum, msg } of targets) {
      const raw = buildMime(msg);
      const rawBuf = Buffer.from(raw, 'utf8');

      const parts = [];

      for (const item of items) {
        const val = this._buildFetchItem(item, msg, raw, rawBuf);
        if (val !== null) {
          parts.push(`${item} ${val}`);
        }
      }

      // Always include UID for UID FETCH
      if (byUid && !items.includes('UID')) {
        parts.push(`UID ${msg.emailId}`);
      }

      if (parts.length > 0) {
        this._send(`* ${seqNum} FETCH (${parts.join(' ')})`);
      }

      // Mark as seen if full body was requested and message is unread
      if (implicitSeen && msg.unread === 0) {
        msg.unread = 1; // optimistic local update
        toMarkRead.push(msg.emailId);
      }
    }

    // Fire-and-forget mark-read
    if (toMarkRead.length > 0) {
      this.client.markRead(toMarkRead).catch(err =>
        console.error('[IMAP] markRead failed:', err.message)
      );
    }

    this._ok(tag, 'FETCH completed');
  }

  /**
   * Build the IMAP fetch value string for a single item.
   * @param {string} item  e.g. 'FLAGS', 'UID', 'BODY[]', 'RFC822'
   * @param {Object} msg
   * @param {string} raw   Full MIME message (utf8 string)
   * @param {Buffer} rawBuf
   * @returns {string|null}
   */
  _buildFetchItem(item, msg, raw, rawBuf) {
    const isDeleted = this.pendingDeletes.has(msg.emailId);
    const isSeen = msg.unread === 1;
    const flagList = [
      ...(isSeen ? ['\\Seen'] : []),
      ...(isDeleted ? ['\\Deleted'] : []),
    ];
    const flagsStr = `(${flagList.join(' ')})`;

    switch (item) {
      case 'FLAGS':
        return flagsStr;

      case 'UID':
        return String(msg.emailId);

      case 'INTERNALDATE': {
        const d = new Date(msg.createTime || Date.now());
        const pad = n => String(n).padStart(2, '0');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `"${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000"`;
      }

      case 'RFC822.SIZE':
        return String(rawBuf.length);

      case 'RFC822':
        return literal(rawBuf);

      case 'RFC822.HEADER': {
        const headers = extractHeaders(raw);
        return literal(Buffer.from(headers, 'utf8'));
      }

      case 'RFC822.TEXT': {
        const body = extractBody(raw);
        return literal(Buffer.from(body, 'utf8'));
      }

      case 'ENVELOPE':
        return buildEnvelope(msg);

      case 'BODY':
      case 'BODYSTRUCTURE':
        return buildBodyStructure(msg);

      case 'BODY[]':
      case 'BODY.PEEK[]':
        return literal(rawBuf);

      case 'BODY[HEADER]':
      case 'BODY.PEEK[HEADER]': {
        const headers = extractHeaders(raw);
        return literal(Buffer.from(headers, 'utf8'));
      }

      case 'BODY[TEXT]':
      case 'BODY.PEEK[TEXT]': {
        const body = extractBody(raw);
        return literal(Buffer.from(body, 'utf8'));
      }

      default:
        // BODY[HEADER.FIELDS (...)]  — return just the requested headers
        if (item.startsWith('BODY[HEADER.FIELDS') || item.startsWith('BODY.PEEK[HEADER.FIELDS')) {
          const fieldMatch = item.match(/\(([^)]+)\)/);
          if (fieldMatch) {
            const requested = fieldMatch[1].toUpperCase().split(/\s+/);
            const allHeaders = extractHeaders(raw);
            const filtered = allHeaders.split('\r\n').filter(line => {
              if (line === '') return true;
              const headerName = line.split(':')[0].toUpperCase();
              return requested.includes(headerName);
            }).join('\r\n');
            return literal(Buffer.from(filtered + '\r\n', 'utf8'));
          }
        }
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // STORE / UID STORE
  // -------------------------------------------------------------------------

  async _cmdStore(tag, args, byUid) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }
    if (this.readOnly) {
      this._no(tag, '[READ-ONLY] Mailbox is read-only');
      return;
    }

    // STORE sequence FLAGS|+FLAGS|-FLAGS (\Deleted) etc.
    const m = args.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)/i) ||
              args.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+(\S+)/i);
    if (!m) { this._bad(tag, 'Syntax: STORE sequence flags'); return; }

    const seqOrUidSet = m[1];
    const operation = m[2].toUpperCase();
    const flagStr = m[3].toUpperCase();
    const silent = operation.includes('.SILENT');

    const total = this.messages.length;
    let targets;
    if (byUid) {
      const uids = this.messages.map(msg => msg.emailId);
      const requestedUids = parseUidSet(seqOrUidSet, uids);
      targets = requestedUids.map(uid => {
        const idx = this.messages.findIndex(m => m.emailId === uid);
        return idx !== -1 ? { seqNum: idx + 1, msg: this.messages[idx] } : null;
      }).filter(Boolean);
    } else {
      const seqNums = parseSequenceSet(seqOrUidSet, total);
      targets = seqNums
        .filter(n => n >= 1 && n <= total)
        .map(n => ({ seqNum: n, msg: this.messages[n - 1] }));
    }

    const flags = flagStr.split(/\s+/).filter(Boolean);
    const markRead = [];

    for (const { seqNum, msg } of targets) {
      const op = operation.replace('.SILENT', '');
      if (op === 'FLAGS' || op === '+FLAGS') {
        if (flags.includes('\\SEEN')) { msg.unread = 1; markRead.push(msg.emailId); }
        if (flags.includes('\\DELETED')) this.pendingDeletes.add(msg.emailId);
      } else if (op === '-FLAGS') {
        if (flags.includes('\\SEEN')) msg.unread = 0;
        if (flags.includes('\\DELETED')) this.pendingDeletes.delete(msg.emailId);
      }

      if (!silent) {
        const isDeleted = this.pendingDeletes.has(msg.emailId);
        const isSeen = msg.unread === 1;
        const flagList = [
          ...(isSeen ? ['\\Seen'] : []),
          ...(isDeleted ? ['\\Deleted'] : []),
        ];
        this._send(`* ${seqNum} FETCH (FLAGS (${flagList.join(' ')}))`);
      }
    }

    if (markRead.length > 0) {
      this.client.markRead(markRead).catch(err =>
        console.error('[IMAP] markRead failed:', err.message)
      );
    }
    // Actual deletion happens on EXPUNGE

    this._ok(tag, 'STORE completed');
  }

  // -------------------------------------------------------------------------
  // EXPUNGE
  // -------------------------------------------------------------------------

  async _cmdExpunge(tag) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }
    if (this.readOnly) {
      this._no(tag, '[READ-ONLY] Mailbox is read-only');
      return;
    }

    if (this.pendingDeletes.size > 0) {
      const idsToDelete = [...this.pendingDeletes];

      if (this.selectedType === 'trash') {
        // For Trash: only delete IDs that still exist in the API (those that
        // were COPY'd).  MOVE'd messages were already deleted from the API.
        const apiIds = idsToDelete.filter(id => this._trashApiIds.has(id));
        if (apiIds.length > 0) {
          try {
            await this.client.deleteEmails(apiIds);
          } catch (err) {
            console.error('[IMAP] deleteEmails (Trash) failed:', err.message);
          }
          for (const id of apiIds) this._trashApiIds.delete(id);
        }
        // Also remove from the session-local trash store.
        this.trashMessages = this.trashMessages.filter(
          m => !this.pendingDeletes.has(m.emailId)
        );
      } else {
        try {
          await this.client.deleteEmails(idsToDelete);
        } catch (err) {
          console.error('[IMAP] deleteEmails failed:', err.message);
        }
        // These IDs no longer exist in the API; remove from the trash-API-ID
        // tracking set to prevent a double-delete when Trash is expunged.
        for (const id of idsToDelete) this._trashApiIds.delete(id);
      }

      // Send EXPUNGE responses in reverse order (required by RFC 3501)
      const expunged = [];
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.pendingDeletes.has(this.messages[i].emailId)) {
          expunged.push(i + 1);
          this.messages.splice(i, 1);
        }
      }
      this.pendingDeletes.clear();

      for (const seq of expunged) {
        this._send(`* ${seq} EXPUNGE`);
      }
    }

    this._ok(tag, 'EXPUNGE completed');
  }

  // -------------------------------------------------------------------------
  // UID EXPUNGE
  // -------------------------------------------------------------------------

  async _cmdUidExpunge(tag, uidSet) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }

    const uids = this.messages.map(m => m.emailId);
    const requestedUids = parseUidSet(uidSet, uids);

    if (requestedUids.length > 0) {
      if (this.selectedType === 'trash') {
        // Only call the API for IDs that still exist there (COPY'd, not MOVE'd).
        const apiIds = requestedUids.filter(id => this._trashApiIds.has(id));
        if (apiIds.length > 0) {
          try {
            await this.client.deleteEmails(apiIds);
          } catch (err) {
            console.error('[IMAP] UID EXPUNGE deleteEmails (Trash) failed:', err.message);
          }
          for (const id of apiIds) this._trashApiIds.delete(id);
        }
        // Remove from session-local trash store.
        this.trashMessages = this.trashMessages.filter(
          m => !requestedUids.includes(m.emailId)
        );
      } else {
        try {
          await this.client.deleteEmails(requestedUids);
        } catch (err) {
          console.error('[IMAP] UID EXPUNGE deleteEmails failed:', err.message);
        }
        for (const id of requestedUids) this._trashApiIds.delete(id);
      }

      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (requestedUids.includes(this.messages[i].emailId)) {
          this._send(`* ${i + 1} EXPUNGE`);
          this.pendingDeletes.delete(this.messages[i].emailId);
          this.messages.splice(i, 1);
        }
      }
    }

    this._ok(tag, 'UID EXPUNGE completed');
  }

  // -------------------------------------------------------------------------
  // SEARCH / UID SEARCH
  // -------------------------------------------------------------------------

  _cmdSearch(tag, args, byUid = false) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }

    // NOTE: SEARCH criteria are intentionally not evaluated.
    // This implementation returns every message in the selected mailbox,
    // regardless of the search criteria supplied by the client.
    // Email clients typically use SEARCH to discover new/unseen messages;
    // returning all messages is safe — the client will simply process more
    // results than strictly necessary.
    // A complete per-criteria implementation (ALL, UNSEEN, SINCE, TEXT, etc.)
    // can be added in a future iteration.
    const results = byUid
      ? this.messages.map(m => m.emailId).join(' ')
      : this.messages.map((_, i) => i + 1).join(' ');

    this._send(`* SEARCH ${results}`);
    this._ok(tag, 'SEARCH completed');
  }

  // -------------------------------------------------------------------------
  // COPY / UID COPY
  // -------------------------------------------------------------------------

  /**
   * Resolve COPY/MOVE source messages from the current mailbox.
   * @param {string} seqOrUidSet  Sequence set or UID set string
   * @param {boolean} byUid
   * @returns {{seqNum: number, msg: Object}[]}
   */
  _resolveCopyTargets(seqOrUidSet, byUid) {
    const total = this.messages.length;
    if (byUid) {
      const uids = this.messages.map(m => m.emailId);
      return parseUidSet(seqOrUidSet, uids)
        .map(uid => {
          const idx = this.messages.findIndex(m => m.emailId === uid);
          return idx !== -1 ? { seqNum: idx + 1, msg: this.messages[idx] } : null;
        })
        .filter(Boolean);
    }
    return parseSequenceSet(seqOrUidSet, total)
      .filter(n => n >= 1 && n <= total)
      .map(n => ({ seqNum: n, msg: this.messages[n - 1] }));
  }

  /**
   * Parse destination-mailbox name from COPY/MOVE args.
   * Accepts:  COPY sequence "Mailbox"  or  COPY sequence Mailbox
   * @param {string} args
   * @returns {{seqOrUidSet: string, destName: string}|null}
   */
  _parseCopyArgs(args) {
    const m = args.match(/^(\S+)\s+"([^"]+)"\s*$/) ||
              args.match(/^(\S+)\s+(\S+)\s*$/);
    if (!m) return null;
    return { seqOrUidSet: m[1], destName: m[2] };
  }

  /**
   * COPY – copy messages to another mailbox (RFC 3501 §6.4.7).
   *
   * Copies to Trash are stored in the session-local trash store.
   * The API copies still exist until the source is EXPUNGE'd; they are tracked
   * in _trashApiIds and permanently deleted when Trash is EXPUNGE'd.
   *
   * Copies between non-Trash folders are not supported by the cloud-mail API
   * and return NO.
   */
  async _cmdCopy(tag, args, byUid) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }

    const parsed = this._parseCopyArgs(args);
    if (!parsed) { this._bad(tag, 'Syntax: COPY sequence mailbox'); return; }

    const { seqOrUidSet, destName } = parsed;
    const destMailbox = await this._resolveMailbox(destName);
    if (!destMailbox) {
      this._no(tag, `[TRYCREATE] No such mailbox: ${destName}`);
      return;
    }

    const targets = this._resolveCopyTargets(seqOrUidSet, byUid);

    if (targets.length === 0) {
      this._ok(tag, 'COPY completed');
      return;
    }

    if (destMailbox.type === 'trash') {
      const srcUids = [];
      const dstUids = [];
      for (const { msg } of targets) {
        if (!this.trashMessages.find(t => t.emailId === msg.emailId)) {
          this.trashMessages.push(msg);
        }
        // The API copy still exists; track it for permanent deletion later.
        this._trashApiIds.add(msg.emailId);
        srcUids.push(msg.emailId);
        dstUids.push(msg.emailId);
      }
      const uidValidity = 1;
      this._ok(tag, `[COPYUID ${uidValidity} ${srcUids.join(',')} ${dstUids.join(',')}] COPY completed`);
      return;
    }

    // Copying between INBOX/Sent is not supported by the cloud-mail API.
    this._no(tag, 'Cannot copy between these folders');
  }

  // -------------------------------------------------------------------------
  // MOVE / UID MOVE  (RFC 6851)
  // -------------------------------------------------------------------------

  /**
   * MOVE – atomically move messages to another mailbox (RFC 6851).
   *
   * Moves to Trash: messages are added to the session-local trash store and
   * immediately deleted from the API, so _trashApiIds tracking is not needed.
   *
   * Moves between non-Trash folders are not supported and return NO.
   */
  async _cmdMove(tag, args, byUid) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }
    if (this.readOnly) {
      this._no(tag, '[READ-ONLY] Mailbox is read-only');
      return;
    }

    const parsed = this._parseCopyArgs(args);
    if (!parsed) { this._bad(tag, 'Syntax: MOVE sequence mailbox'); return; }

    const { seqOrUidSet, destName } = parsed;
    const destMailbox = await this._resolveMailbox(destName);
    if (!destMailbox) {
      this._no(tag, `[TRYCREATE] No such mailbox: ${destName}`);
      return;
    }

    const targets = this._resolveCopyTargets(seqOrUidSet, byUid);

    if (targets.length === 0) {
      this._ok(tag, 'MOVE completed');
      return;
    }

    if (destMailbox.type === 'trash') {
      const srcUids = [];
      const dstUids = [];
      for (const { msg } of targets) {
        if (!this.trashMessages.find(t => t.emailId === msg.emailId)) {
          this.trashMessages.push(msg);
        }
        srcUids.push(msg.emailId);
        dstUids.push(msg.emailId);
      }

      // MOVE semantics: permanently delete from the API immediately.
      try {
        await this.client.deleteEmails(srcUids);
      } catch (err) {
        console.error('[IMAP] MOVE deleteEmails failed:', err.message);
      }
      // These IDs are gone from the API; ensure _trashApiIds won't double-delete.
      for (const id of srcUids) this._trashApiIds.delete(id);

      // Remove from current mailbox view; send EXPUNGE in reverse order.
      const sortedTargets = [...targets].sort((a, b) => b.seqNum - a.seqNum);
      for (const { seqNum, msg } of sortedTargets) {
        this.pendingDeletes.delete(msg.emailId);
        this.messages.splice(seqNum - 1, 1);
        this._send(`* ${seqNum} EXPUNGE`);
      }

      const uidValidity = 1;
      this._ok(tag, `[COPYUID ${uidValidity} ${srcUids.join(',')} ${dstUids.join(',')}] MOVE completed`);
      return;
    }

    // Moving between INBOX/Sent is not supported by the cloud-mail API.
    this._no(tag, 'Cannot move between these folders');
  }

  // -------------------------------------------------------------------------
  // CLOSE
  // -------------------------------------------------------------------------
  async _cmdClose(tag) {
    if (this.state !== 'SELECTED') {
      this._no(tag, 'No mailbox selected');
      return;
    }

    // Silently expunge deleted messages
    if (!this.readOnly && this.pendingDeletes.size > 0) {
      try {
        const idsToDelete = [...this.pendingDeletes];
        await this.client.deleteEmails(idsToDelete);
        for (const id of idsToDelete) this._trashApiIds.delete(id);
      } catch (err) {
        console.error('[IMAP] CLOSE deleteEmails failed:', err.message);
      }
      this.pendingDeletes.clear();
    }

    this.state = 'AUTHENTICATED';
    this.selectedType = null;
    this.selectedMailboxKey = null;
    this.messages = [];
    this._ok(tag, 'CLOSE completed');
  }
}

// ---------------------------------------------------------------------------
// ImapServer
// ---------------------------------------------------------------------------

class ImapServer {
  /**
   * @param {string} cloudMailUrl  Base URL of the cloud-mail worker
   */
  constructor(cloudMailUrl) {
    this.cloudMailUrl = cloudMailUrl;
    this.server = net.createServer(socket => this._onConnection(socket));
  }

  _onConnection(socket) {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[IMAP] connection from ${remote}`);
    socket.on('close', () => console.log(`[IMAP] ${remote} disconnected`));
    new ImapSession(socket, this.cloudMailUrl);
  }

  /**
   * Start listening.
   * @param {number} port
   * @param {string} host
   * @returns {Promise<void>}
   */
  listen(port, host) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        console.log(`[IMAP] listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  close() {
    return new Promise(resolve => this.server.close(resolve));
  }
}

module.exports = ImapServer;
