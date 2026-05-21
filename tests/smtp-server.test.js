'use strict';

const SmtpBridgeServer = require('../src/smtp/smtp-server');

describe('SmtpBridgeServer account resolution', () => {
  const server = new SmtpBridgeServer('https://mail.example.com');

  test('matches sender against account receive-address list', () => {
    const accounts = [
      {
        accountId: 1,
        email: 'main@example.com',
        receiveList: ['alias@example.com'],
      },
      {
        accountId: 2,
        email: 'other@example.com',
      },
    ];

    const resolved = server._findAccountByAddress(accounts, 'alias@example.com');
    expect(resolved.accountId).toBe(1);
  });

  test('falls back to the first account when sender has no match', () => {
    const accounts = [
      { accountId: 10, email: 'first@example.com' },
      { accountId: 20, email: 'second@example.com' },
    ];

    const resolved = server._findAccountByAddress(accounts, 'missing@example.com');
    expect(resolved.accountId).toBe(10);
  });
});
