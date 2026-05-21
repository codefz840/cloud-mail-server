'use strict';

const axios = require('axios');
const CloudMailClient = require('../src/api/cloud-mail-client');

jest.mock('axios');

function createHttpError(status, data, message = `HTTP ${status}`) {
  const error = new Error(message);
  error.response = { status, data };
  return error;
}

describe('CloudMailClient API fallback and error handling', () => {
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

  test('login retries from /api/login to /login on 404', async () => {
    axios
      .mockRejectedValueOnce(createHttpError(404))
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
      message: 'POST /login failed: HTTP 401',
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

  test('base URL already ending with /api does not fall back to root routes', async () => {
    axios.mockRejectedValueOnce(createHttpError(405));

    const client = new CloudMailClient('https://mail.example.com/api');
    await expect(client.login('admin@example.com', 'secret')).rejects.toMatchObject({
      message: 'POST /login failed: HTTP 405',
    });
    expect(axios).toHaveBeenCalledTimes(1);
  });

  test('wraps Axios-style circular login failures in a serializable error', async () => {
    const client = new CloudMailClient('https://mail.example.com');
    const error = new Error('socket hang up');
    const request = {};
    const response = { status: 502, data: { message: 'bad gateway' }, request };
    request.response = response;
    error.response = response;

    axios.mockRejectedValueOnce(error);

    await expect(client.login('user@example.com', 'secret')).rejects.toMatchObject({
      message: 'POST /login failed: socket hang up | status 502 | {"message":"bad gateway"}',
    });
  });

  test('fetchAllEmails uses account filter when accountId is provided', async () => {
    axios.mockResolvedValueOnce({
      data: {
        code: 200,
        data: { list: [{ emailId: 1001 }], total: 1, latestEmail: null },
      },
    });

    const client = new CloudMailClient('https://mail.example.com');
    client.token = 'jwt-token';
    const emails = await client.fetchAllEmails(0, 50, { accountId: 123 });

    expect(emails).toEqual([{ emailId: 1001 }]);
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://mail.example.com/api/email/list',
        params: expect.objectContaining({
          type: 0,
          size: 50,
          allReceive: 0,
          accountId: 123,
        }),
      })
    );
  });
});
