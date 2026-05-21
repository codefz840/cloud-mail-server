'use strict';

const axios = require('axios');
const CloudMailClient = require('../src/api/cloud-mail-client');

jest.mock('axios');

function createHttpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.response = { status };
  return err;
}

describe('CloudMailClient API path fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('login retries from /api/login to /login on 405', async () => {
    axios
      .mockRejectedValueOnce(createHttpError(405))
      .mockResolvedValueOnce({ data: { code: 200, data: { token: 'jwt-token' } } });

    const client = new CloudMailClient('https://mail.example.com');
    const token = await client.login('admin@example.com', 'secret');

    expect(token).toBe('jwt-token');
    expect(axios).toHaveBeenCalledTimes(2);
    expect(axios).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://mail.example.com/api/login',
      })
    );
    expect(axios).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://mail.example.com/login',
      })
    );
  });

  test('login does not retry on 401', async () => {
    axios.mockRejectedValueOnce(createHttpError(401));

    const client = new CloudMailClient('https://mail.example.com');
    await expect(client.login('admin@example.com', 'bad-password')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(axios).toHaveBeenCalledTimes(1);
  });

  test('authenticated API calls also fallback on 405', async () => {
    axios
      .mockRejectedValueOnce(createHttpError(405))
      .mockResolvedValueOnce({ data: { code: 200, data: [] } });

    const client = new CloudMailClient('https://mail.example.com');
    client.token = 'jwt-token';
    const accounts = await client.listAccounts();

    expect(accounts).toEqual([]);
    expect(axios).toHaveBeenCalledTimes(2);
    expect(axios).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://mail.example.com/api/account/list',
        headers: { Authorization: 'Bearer jwt-token' },
      })
    );
    expect(axios).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://mail.example.com/account/list',
        headers: { Authorization: 'Bearer jwt-token' },
      })
    );
  });

  test('base URL already ending with /api does not duplicate path', async () => {
    axios.mockResolvedValueOnce({ data: { code: 200, data: { token: 'jwt-token' } } });

    const client = new CloudMailClient('https://mail.example.com/api');
    await client.login('admin@example.com', 'secret');

    expect(axios).toHaveBeenCalledTimes(1);
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://mail.example.com/api/login',
      })
    );
  });
});
