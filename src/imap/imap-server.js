'use strict';

/**
 * IMAP4rev1 server (RFC 3501) that bridges to the cloud-mail API.
 *
 * Supported commands:
 *   CAPABILITY, NOOP, LOGOUT, LOGIN, LIST, LSUB, SELECT, EXAMINE,
 *   STATUS, FETCH, UID FETCH, STORE, UID STORE, EXPUNGE, SEARCH,
 *   UID SEARCH, CLOSE
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPABILITIES = 'IMAP4rev1 LITERAL+ UIDPLUS IDLE';

/** Map well-known IMAP folder names to cloud-mail email types */
const FOLDER_MAP = {
  INBOX: 0,
  SENT: 1,
  'SENT MESSAGES': 1,
  'SENT ITEMS': 1,
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

    /** cloud-mail type for selected folder (0=INBOX, 1=Sent) */
    this.selectedType = null;

    this._buffer = '';

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
    // IMAP command: TAG COMMAND [args...]
    const m = line.match(/^(\S+)\s+(\S+)(.*)?$/);
    if (!m) { this._send('* BAD Invalid command'); return; }

    const tag = m[1];
    const command = m[2].toUpperCase();
    const rest = (m[3] || '').trim();

    try {
      switch (command) {
        case 'CAPABILITY': this._cmdCapability(tag); break;
        case 'NOOP':       this._ok(tag, 'NOOP completed'); break;
        case 'LOGOUT':     await this._cmdLogout(tag); break;
        case 'LOGIN':      await this._cmdLogin(tag, rest); break;
        case 'LIST':       this._cmdList(tag, rest); break;
        case 'LSUB':       this._cmdLsub(tag, rest); break;
        case 'SELECT':     await this._cmdSelect(tag, rest, false); break;
        case 'EXAMINE':    await this._cmdSelect(tag, rest, true); break;
        case 'STATUS':     await this._cmdStatus(tag, rest); break;
        case 'FETCH':      await this._cmdFetch(tag, rest, false); break;
        case 'STORE':      await this._cmdStore(tag, rest, false); break;
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
            case 'EXPUNGE': await this._cmdUidExpunge(tag, subArgs); break;
            case 'SEARCH':  this._cmdSearch(tag, subArgs); break;
            default: this._bad(tag, `Unknown UID sub-command: ${subCmd}`);
          }
          break;
        }
        case 'IDLE': {
          // Minimal IDLE: just acknowledge, wait for DONE
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
  // LOGIN
  // -------------------------------------------------------------------------

  async _cmdLogin(tag, args) {
    if (this.state !== 'NOT_AUTHENTICATED') {
      this._no(tag, 'Already authenticated');
      return;
    }

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

    try {
      await this.client.login(username, password);
      this.state = 'AUTHENTICATED';
      this._ok(tag, 'LOGIN completed');
    } catch (err) {
      this._no(tag, `LOGIN failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // LIST / LSUB
  // -------------------------------------------------------------------------

  _cmdList(tag, args) {
    if (this.state === 'NOT_AUTHENTICATED') {
      this._no(tag, 'Not authenticated');
      return;
    }

    // Parse: LIST "" "*"  or LIST "" "INBOX"
    // We expose a fixed folder list regardless of the pattern
    this._send('* LIST (\\HasNoChildren) "/" "INBOX"');
    this._send('* LIST (\\HasNoChildren \\Sent) "/" "Sent"');
    this._ok(tag, 'LIST completed');
  }

  _cmdLsub(tag) {
    if (this.state === 'NOT_AUTHENTICATED') {
      this._no(tag, 'Not authenticated');
      return;
    }

    this._send('* LSUB (\\HasNoChildren) "/" "INBOX"');
    this._send('* LSUB (\\HasNoChildren \\Sent) "/" "Sent"');
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

    // Strip surrounding quotes
    const folderName = args.replace(/^["']|["']$/g, '').trim().toUpperCase();
    const type = FOLDER_MAP[folderName];
    if (type === undefined) {
      this._no(tag, `Mailbox does not exist: ${args}`);
      return;
    }

    this.state = 'SELECTED';
    this.readOnly = readOnly;
    this.selectedType = type;
    this.pendingDeletes.clear();

    // Fetch emails from cloud-mail
    this.messages = await this.client.fetchAllEmails(type);
    // Ensure oldest-to-newest order (ascending emailId) for IMAP sequence numbers
    this.messages.sort((a, b) => a.emailId - b.emailId);

    const total = this.messages.length;
    const unseen = this.messages.filter(m => m.unread === 1).length;
    const uidValidity = 1; // fixed; we don't need to change mailboxes
    const uidNext = total > 0 ? this.messages[total - 1].emailId + 1 : 1;

    this._send(`* ${total} EXISTS`);
    this._send(`* 0 RECENT`);
    if (unseen > 0) {
      // Find the first unseen message's sequence number
      const firstUnseen = this.messages.findIndex(m => m.unread === 1) + 1;
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

    const m = args.match(/^"?([^"\s]+)"?\s+\(([^)]+)\)/);
    if (!m) { this._bad(tag, 'Syntax: STATUS mailbox (items)'); return; }

    const folderName = m[1].toUpperCase();
    const type = FOLDER_MAP[folderName];
    if (type === undefined) {
      this._no(tag, `No such mailbox: ${m[1]}`);
      return;
    }

    let messages;
    if (this.selectedType === type) {
      messages = this.messages;
    } else {
      messages = await this.client.fetchAllEmails(type);
    }

    const total = messages.length;
    const unseen = messages.filter(m => m.unread === 1).length;
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
      if (implicitSeen && msg.unread === 1) {
        msg.unread = 0; // optimistic local update
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
    const isSeen = msg.unread === 0;
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
    const markDeleted = [];

    for (const { seqNum, msg } of targets) {
      const op = operation.replace('.SILENT', '');
      if (op === 'FLAGS' || op === '+FLAGS') {
        if (flags.includes('\\SEEN')) { msg.unread = 0; markRead.push(msg.emailId); }
        if (flags.includes('\\DELETED')) this.pendingDeletes.add(msg.emailId);
      } else if (op === '-FLAGS') {
        if (flags.includes('\\SEEN')) msg.unread = 1;
        if (flags.includes('\\DELETED')) this.pendingDeletes.delete(msg.emailId);
      }

      if (!silent) {
        const isDeleted = this.pendingDeletes.has(msg.emailId);
        const isSeen = msg.unread === 0;
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
      try {
        await this.client.deleteEmails(idsToDelete);
      } catch (err) {
        console.error('[IMAP] deleteEmails failed:', err.message);
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
      try {
        await this.client.deleteEmails(requestedUids);
      } catch (err) {
        console.error('[IMAP] UID EXPUNGE deleteEmails failed:', err.message);
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

  _cmdSearch(tag, args) {
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
    const nums = this.messages
      .map((_, i) => i + 1)
      .join(' ');

    this._send(`* SEARCH ${nums}`);
    this._ok(tag, 'SEARCH completed');
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
        await this.client.deleteEmails([...this.pendingDeletes]);
      } catch (err) {
        console.error('[IMAP] CLOSE deleteEmails failed:', err.message);
      }
      this.pendingDeletes.clear();
    }

    this.state = 'AUTHENTICATED';
    this.selectedType = null;
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
