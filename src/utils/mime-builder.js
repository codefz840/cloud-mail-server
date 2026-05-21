'use strict';

/**
 * Converts a cloud-mail email object to an RFC 2822 / MIME-formatted string
 * that IMAP clients can display.
 */

/**
 * Encode a header value containing non-ASCII characters using RFC 2047
 * UTF-8 base64 encoding.
 * @param {string} value
 * @returns {string}
 */
function encodeMimeHeader(value) {
  if (!value) return '';
  // If purely ASCII, return as-is
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Escape a display-name string for safe inclusion inside an RFC 2822 quoted-string.
 * Backslashes must be escaped before double-quotes to avoid partial sanitization.
 * @param {string} name
 * @returns {string}
 */
function escapeDisplayName(name) {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build an RFC 2822 "From" / "To" address header value.
 * @param {string} name   Display name (may be empty)
 * @param {string} email  Email address
 * @returns {string}
 */
function buildAddress(name, email) {
  if (!name) return email || '';
  const encodedName = encodeMimeHeader(escapeDisplayName(name));
  return `"${encodedName}" <${email}>`;
}

/**
 * Format a date string from cloud-mail (CURRENT_TIMESTAMP / ISO) to RFC 2822.
 * Falls back to current time on parse failure.
 * @param {string} createTime
 * @returns {string} RFC 2822 date string, e.g. "Thu, 01 Jan 2024 00:00:00 +0000"
 */
function formatDate(createTime) {
  try {
    const d = new Date(createTime);
    if (!isNaN(d.getTime())) return d.toUTCString();
  } catch (_) {}
  return new Date().toUTCString();
}

/**
 * Parse JSON that might be a stringified array; return [] on failure.
 * @param {string|Array} value
 * @returns {Array}
 */
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || value === '[]') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Build a complete RFC 2822 MIME message from a cloud-mail email object.
 *
 * cloud-mail email fields used:
 *   emailId, sendEmail, name, toEmail, toName, subject, text, content,
 *   cc, bcc, inReplyTo, messageId, createTime, unread, type
 *
 * @param {Object} email  cloud-mail email object
 * @returns {string}  The full MIME message as a string
 */
function buildMime(email) {
  const boundary = `----=_Part_${email.emailId}_${Date.now()}`;
  const date = formatDate(email.createTime);

  // Build From / To / Cc / Bcc
  const from = buildAddress(email.name, email.sendEmail);
  const to = email.toName
    ? buildAddress(email.toName, email.toEmail)
    : (email.toEmail || '');
  const ccList = parseJsonArray(email.cc);
  const bccList = parseJsonArray(email.bcc);

  // Message-ID: prefer stored value, otherwise generate from emailId
  const messageId = email.messageId && email.messageId.trim()
    ? email.messageId.trim()
    : `<${email.emailId}@cloud-mail-server>`;

  // Build header lines
  const headerLines = [
    `MIME-Version: 1.0`,
    `Message-ID: ${messageId}`,
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(email.subject || '')}`,
  ];

  if (ccList.length > 0) {
    headerLines.push(`Cc: ${ccList.join(', ')}`);
  }
  if (bccList.length > 0) {
    headerLines.push(`Bcc: ${bccList.join(', ')}`);
  }
  if (email.inReplyTo && email.inReplyTo.trim()) {
    headerLines.push(`In-Reply-To: ${email.inReplyTo.trim()}`);
  }

  const hasHtml = !!(email.content && email.content.trim());
  const hasText = !!(email.text && email.text.trim());

  let bodyLines;

  if (hasHtml && hasText) {
    // multipart/alternative with plain text + HTML
    headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    bodyLines = [
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from(email.text, 'utf8').toString('base64'),
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from(email.content, 'utf8').toString('base64'),
      '',
      `--${boundary}--`,
    ];
  } else if (hasHtml) {
    headerLines.push(`Content-Type: text/html; charset=utf-8`);
    headerLines.push(`Content-Transfer-Encoding: base64`);
    bodyLines = ['', Buffer.from(email.content, 'utf8').toString('base64')];
  } else {
    // Plain text (or empty body)
    headerLines.push(`Content-Type: text/plain; charset=utf-8`);
    headerLines.push(`Content-Transfer-Encoding: base64`);
    bodyLines = ['', Buffer.from(email.text || '', 'utf8').toString('base64')];
  }

  return headerLines.join('\r\n') + '\r\n' + bodyLines.join('\r\n');
}

/**
 * Extract only the headers from a MIME message string.
 * @param {string} raw  Full MIME message
 * @returns {string}  Just the header section (including trailing blank line)
 */
function extractHeaders(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx === -1) return raw + '\r\n\r\n';
  return raw.slice(0, idx + 4);
}

/**
 * Extract only the body from a MIME message string (everything after the blank line).
 * @param {string} raw  Full MIME message
 * @returns {string}
 */
function extractBody(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx === -1) return '';
  return raw.slice(idx + 4);
}

/**
 * Build IMAP ENVELOPE data structure string from a cloud-mail email object.
 * Format: (date subject from sender reply-to to cc bcc in-reply-to message-id)
 * Each address list: ((name NIL mailbox host)) or NIL
 * @param {Object} email
 * @returns {string}
 */
function buildEnvelope(email) {
  const date = `"${formatDate(email.createTime)}"`;
  const subject = email.subject
    ? `"${encodeMimeHeader(escapeDisplayName(email.subject))}"`
    : 'NIL';

  function addressList(name, addr) {
    if (!addr) return 'NIL';
    const addrParts = addr.split('@');
    const mailbox = addrParts[0] || addr;
    const host = addrParts[1] || '';
    const nameStr = name ? `"${encodeMimeHeader(escapeDisplayName(name))}"` : 'NIL';
    return `((${nameStr} NIL "${mailbox}" "${host}"))`;
  }

  const from = addressList(email.name, email.sendEmail);
  const toAddr = addressList(email.toName, email.toEmail);

  const ccList = parseJsonArray(email.cc);
  let cc = 'NIL';
  if (ccList.length > 0) {
    cc = '(' + ccList.map(a => addressList('', a)).join(' ') + ')';
  }

  const inReplyTo = email.inReplyTo && email.inReplyTo.trim()
    ? `"${email.inReplyTo.trim()}"`
    : 'NIL';

  const messageId = email.messageId && email.messageId.trim()
    ? `"${email.messageId.trim()}"`
    : `"<${email.emailId}@cloud-mail-server>"`;

  return `(${date} ${subject} ${from} ${from} NIL ${toAddr} ${cc} NIL ${inReplyTo} ${messageId})`;
}

/**
 * Build a simplified IMAP BODYSTRUCTURE string.
 * @param {Object} email
 * @returns {string}
 */
function buildBodyStructure(email) {
  const hasHtml = !!(email.content && email.content.trim());
  const hasText = !!(email.text && email.text.trim());

  function textPart(subtype, content) {
    // Compute the size of the base64-encoded content (as it will be transmitted)
    const b64 = Buffer.from(content || '', 'utf8').toString('base64');
    const size = Buffer.byteLength(b64, 'ascii');
    const lines = (content || '').split('\n').length;
    return `("TEXT" "${subtype.toUpperCase()}" ("CHARSET" "utf-8") NIL NIL "BASE64" ${size} ${lines})`;
  }

  if (hasHtml && hasText) {
    return `(${textPart('PLAIN', email.text)} ${textPart('HTML', email.content)} "ALTERNATIVE")`;
  } else if (hasHtml) {
    return textPart('HTML', email.content);
  } else {
    return textPart('PLAIN', email.text || '');
  }
}

module.exports = { buildMime, extractHeaders, extractBody, buildEnvelope, buildBodyStructure, encodeMimeHeader };
