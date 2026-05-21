'use strict';

const {
  buildMime,
  extractHeaders,
  extractBody,
  buildEnvelope,
  buildBodyStructure,
  encodeMimeHeader,
} = require('../src/utils/mime-builder');

// Minimal cloud-mail email object fixture
const emailReceived = {
  emailId: 42,
  sendEmail: 'alice@example.com',
  name: 'Alice Smith',
  toEmail: 'bob@example.com',
  toName: 'Bob',
  subject: 'Hello World',
  text: 'Plain text body',
  content: '<p>HTML body</p>',
  cc: '[]',
  bcc: '[]',
  inReplyTo: '',
  messageId: '',
  createTime: '2024-01-15 10:00:00',
  unread: 1,
  type: 0,
};

const emailNoHtml = {
  ...emailReceived,
  emailId: 43,
  content: '',
  text: 'Only plain text',
};

const emailNonAsciiSubject = {
  ...emailReceived,
  emailId: 44,
  subject: '測試郵件',
};

// ---------------------------------------------------------------------------
// encodeMimeHeader
// ---------------------------------------------------------------------------
describe('encodeMimeHeader', () => {
  test('leaves ASCII strings unchanged', () => {
    expect(encodeMimeHeader('Hello World')).toBe('Hello World');
  });

  test('encodes non-ASCII strings as RFC 2047 UTF-8 base64', () => {
    const encoded = encodeMimeHeader('測試');
    expect(encoded).toMatch(/=\?UTF-8\?B\?/);
    // Decode and verify round-trip
    const b64 = encoded.replace(/=\?UTF-8\?B\?(.+)\?=/, '$1');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('測試');
  });

  test('returns empty string for falsy input', () => {
    expect(encodeMimeHeader('')).toBe('');
    expect(encodeMimeHeader(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildMime
// ---------------------------------------------------------------------------
describe('buildMime', () => {
  test('produces a non-empty string', () => {
    expect(typeof buildMime(emailReceived)).toBe('string');
    expect(buildMime(emailReceived).length).toBeGreaterThan(0);
  });

  test('includes essential headers', () => {
    const mime = buildMime(emailReceived);
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toContain('From:');
    expect(mime).toContain('To:');
    expect(mime).toContain('Subject:');
    expect(mime).toContain('Date:');
    expect(mime).toContain('Message-ID:');
  });

  test('multipart/alternative for email with both text and html', () => {
    const mime = buildMime(emailReceived);
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('text/plain');
    expect(mime).toContain('text/html');
  });

  test('plain-text only when no html content', () => {
    const mime = buildMime(emailNoHtml);
    expect(mime).not.toContain('multipart/alternative');
    expect(mime).toContain('text/plain');
    expect(mime).not.toContain('text/html');
  });

  test('encodes non-ASCII subject correctly', () => {
    const mime = buildMime(emailNonAsciiSubject);
    expect(mime).toContain('=?UTF-8?B?');
  });

  test('uses stored messageId when present', () => {
    const email = { ...emailReceived, messageId: '<stored@example.com>' };
    const mime = buildMime(email);
    expect(mime).toContain('Message-ID: <stored@example.com>');
  });

  test('generates messageId from emailId when none stored', () => {
    const mime = buildMime(emailReceived);
    expect(mime).toContain(`Message-ID: <42@cloud-mail-server>`);
  });
});

// ---------------------------------------------------------------------------
// extractHeaders / extractBody
// ---------------------------------------------------------------------------
describe('extractHeaders and extractBody', () => {
  test('splits message correctly', () => {
    const mime = buildMime(emailReceived);
    const headers = extractHeaders(mime);
    const body = extractBody(mime);

    expect(headers).toContain('MIME-Version');
    expect(headers).not.toContain('<p>');
    expect(body.length).toBeGreaterThan(0);
    // The headers section should end with \r\n\r\n
    expect(headers.endsWith('\r\n\r\n')).toBe(true);
  });

  test('handles message with no blank line gracefully', () => {
    const raw = 'From: test@example.com';
    const headers = extractHeaders(raw);
    expect(headers).toContain('From:');
    expect(extractBody(raw)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------
describe('buildEnvelope', () => {
  test('returns parenthesised ENVELOPE string', () => {
    const env = buildEnvelope(emailReceived);
    expect(env).toMatch(/^\(.*\)$/);
  });

  test('contains expected fields', () => {
    const env = buildEnvelope(emailReceived);
    // Date should be present
    expect(env.length).toBeGreaterThan(10);
    // Subject "Hello World" is ASCII — appears literally
    expect(env).toContain('"Hello World"');
    // alice@example.com should appear as mailbox/host pair
    expect(env).toContain('"alice"');
    expect(env).toContain('"example.com"');
  });

  test('handles missing fields gracefully', () => {
    const minimal = { emailId: 1, createTime: '2024-01-01 00:00:00' };
    expect(() => buildEnvelope(minimal)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildBodyStructure
// ---------------------------------------------------------------------------
describe('buildBodyStructure', () => {
  test('returns multipart structure for email with html+text', () => {
    const bs = buildBodyStructure(emailReceived);
    expect(bs).toContain('ALTERNATIVE');
    expect(bs).toContain('"TEXT"');
  });

  test('returns plain text structure for text-only email', () => {
    const bs = buildBodyStructure(emailNoHtml);
    expect(bs).toContain('"PLAIN"');
    expect(bs).not.toContain('ALTERNATIVE');
  });

  test('returns parenthesised structure', () => {
    const bs = buildBodyStructure(emailReceived);
    expect(bs.startsWith('(')).toBe(true);
    expect(bs.endsWith(')')).toBe(true);
  });
});
