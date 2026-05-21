'use strict';

const CloudMailClient = require('../src/api/cloud-mail-client');

const requiredEnvVars = ['CLOUD_MAIL_URL', 'TEST_MAIL_USER', 'TEST_MAIL_PASS'];
const missingEnvVars = requiredEnvVars.filter(name => !process.env[name]);
const describeIfConfigured = missingEnvVars.length === 0 ? describe : describe.skip;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, message, attempts = 12, delayMs = 5000) {
  let lastValue;

  for (let attempt = 0; attempt < attempts; attempt++) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await sleep(delayMs);
  }

  throw new Error(message);
}

describeIfConfigured('CloudMailClient integration', () => {
  jest.setTimeout(120000);

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const subject = `[cloud-mail-server] integration ${uniqueId}`;
  const text = `integration test ${uniqueId}`;
  const html = `<p>${text}</p>`;

  let client;
  let account;
  let sentEmailId;
  let inboxEmailId;

  async function fetchEmailBySubject(type) {
    const emails = await client.fetchAllEmails(type, 100);
    return emails.find(email => email.subject === subject);
  }

  afterAll(async () => {
    if (!client) return;

    const emailIds = [inboxEmailId, sentEmailId].filter(Boolean);
    if (emailIds.length > 0) {
      try {
        await client.deleteEmails(emailIds);
      } catch (_) {
        // Best-effort cleanup for remote integration state.
      }
    }

    await client.logout();
  });

  test('covers login, account, email, read, delete, and logout flows', async () => {
    client = new CloudMailClient(process.env.CLOUD_MAIL_URL);

    const token = await client.login(process.env.TEST_MAIL_USER, process.env.TEST_MAIL_PASS);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const accounts = await client.listAccounts();
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);

    account = accounts.find(item =>
      item.email && item.email.toLowerCase() === process.env.TEST_MAIL_USER.toLowerCase()
    ) || accounts[0];

    expect(account).toBeDefined();
    expect(account.accountId).toBeDefined();
    expect(account.email).toBeTruthy();

    const inboxPage = await client.listEmails({ type: 0, size: 10 });
    expect(Array.isArray(inboxPage.list)).toBe(true);
    expect(inboxPage).toHaveProperty('total');

    const sentEmail = await client.sendEmail({
      accountId: account.accountId,
      name: account.name || account.email,
      receiveEmail: [account.email],
      subject,
      text,
      content: html,
      attachments: [],
    });

    expect(sentEmail).toBeTruthy();

    const inboxEmail = await waitFor(
      () => fetchEmailBySubject(0),
      `Timed out waiting for inbox email "${subject}"`
    );
    inboxEmailId = inboxEmail.emailId;
    expect(inboxEmailId).toBeDefined();

    const sentCopy = await waitFor(
      () => fetchEmailBySubject(1),
      `Timed out waiting for sent email "${subject}"`
    );
    sentEmailId = sentCopy.emailId;
    expect(sentEmailId).toBeDefined();

    await client.markRead([inboxEmailId]);

    const readInboxEmail = await waitFor(
      async () => {
        const email = await fetchEmailBySubject(0);
        return email && email.unread === 0 ? email : null;
      },
      `Timed out waiting for inbox email "${subject}" to be marked as read`
    );
    expect(readInboxEmail.unread).toBe(0);

    const allInboxEmails = await client.fetchAllEmails(0, 100);
    expect(allInboxEmails.some(email => email.emailId === inboxEmailId)).toBe(true);

    await client.deleteEmails([inboxEmailId, sentEmailId]);

    await waitFor(
      async () => {
        const email = await fetchEmailBySubject(0);
        return email ? null : true;
      },
      `Timed out waiting for inbox email "${subject}" to be deleted`
    );

    await waitFor(
      async () => {
        const email = await fetchEmailBySubject(1);
        return email ? null : true;
      },
      `Timed out waiting for sent email "${subject}" to be deleted`
    );

    inboxEmailId = null;
    sentEmailId = null;

    await client.logout();
    expect(client.token).toBeNull();
    client = null;
  });
});
