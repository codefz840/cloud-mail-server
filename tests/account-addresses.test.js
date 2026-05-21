'use strict';

const { extractAccountAddresses } = require('../src/utils/account-addresses');

describe('extractAccountAddresses', () => {
  test('extracts primary and nested receive addresses', () => {
    const account = {
      email: 'primary@example.com',
      receiveList: ['alias1@example.com', 'alias2@example.com'],
      settings: {
        receiveEmailList: [
          { email: 'alias3@example.com' },
          { address: 'alias4@example.com' },
        ],
      },
    };

    expect(extractAccountAddresses(account)).toEqual([
      'primary@example.com',
      'alias1@example.com',
      'alias2@example.com',
      'alias3@example.com',
      'alias4@example.com',
    ]);
  });

  test('deduplicates addresses case-insensitively', () => {
    const account = {
      email: 'Primary@Example.com',
      receiveEmails: 'primary@example.com;Alias@Example.com',
      receiveAddressList: ['alias@example.com'],
    };

    expect(extractAccountAddresses(account)).toEqual([
      'Primary@Example.com',
      'Alias@Example.com',
    ]);
  });
});
