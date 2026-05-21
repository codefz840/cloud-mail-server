'use strict';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
}));

const axios = require('axios');
const CloudMailClient = require('../src/api/cloud-mail-client');

describe('CloudMailClient error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('wraps Axios-style circular login failures in a serializable error', async () => {
    const client = new CloudMailClient('https://mail.example.com');
    const error = new Error('socket hang up');
    const request = {};
    const response = { status: 502, data: { message: 'bad gateway' }, request };
    request.response = response;
    error.response = response;

    axios.post.mockRejectedValue(error);

    await expect(client.login('user@example.com', 'secret')).rejects.toMatchObject({
      message: 'POST /login failed: socket hang up | status 502 | {"message":"bad gateway"}',
    });
  });
});
