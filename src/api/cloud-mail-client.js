'use strict';

const axios = require('axios');

/**
 * HTTP client that wraps the cloud-mail REST API.
 * Each instance holds its own JWT token after login.
 */
class CloudMailClient {
  /**
   * @param {string} baseUrl  Base URL of the cloud-mail worker, e.g. https://mail.example.com
   */
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  _buildRequestError(action, error) {
    if (!error || typeof error !== 'object') {
      return new Error(`${action} failed`);
    }

    const parts = [];
    if (error.message) {
      parts.push(error.message);
    }

    const status = error.response && error.response.status;
    if (status) {
      parts.push(`status ${status}`);
    }

    const data = error.response && error.response.data;
    if (data !== undefined) {
      if (typeof data === 'string') {
        parts.push(data);
      } else {
        try {
          parts.push(JSON.stringify(data));
        } catch (_) {
          parts.push('[unserializable response body]');
        }
      }
    }

    return new Error(`${action} failed: ${parts.join(' | ') || 'request error'}`);
  }

  async _request(action, fn) {
    try {
      return await fn();
    } catch (error) {
      throw this._buildRequestError(action, error);
    }
  }

  async _get(path, params = {}) {
    const res = await this._request(`GET ${path}`, () => axios.get(`${this.baseUrl}${path}`, {
      headers: this._authHeaders(),
      params,
    }));
    return res.data;
  }

  async _post(path, data = {}) {
    const res = await this._request(`POST ${path}`, () => axios.post(`${this.baseUrl}${path}`, data, {
      headers: this._authHeaders(),
    }));
    return res.data;
  }

  async _put(path, data = {}) {
    const res = await this._request(`PUT ${path}`, () => axios.put(`${this.baseUrl}${path}`, data, {
      headers: this._authHeaders(),
    }));
    return res.data;
  }

  async _delete(path, params = {}) {
    const res = await this._request(`DELETE ${path}`, () => axios.delete(`${this.baseUrl}${path}`, {
      headers: this._authHeaders(),
      params,
    }));
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Login to cloud-mail and store the JWT token.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<string>} JWT token
   */
  async login(email, password) {
    const res = await this._request('POST /login', () => axios.post(`${this.baseUrl}/login`, { email, password }));
    const body = res.data;
    if (!body || body.code !== 200 || !body.data || !body.data.token) {
      throw new Error('Login failed: ' + JSON.stringify(body));
    }
    this.token = body.data.token;
    return this.token;
  }

  /**
   * Logout and clear the stored token.
   */
  async logout() {
    try {
      await this._delete('/logout');
    } catch (_) {
      // Ignore errors during logout
    }
    this.token = null;
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  /**
   * Fetch all mail accounts for the logged-in user (paginates automatically).
   * @returns {Promise<Array>} List of account objects
   */
  async listAccounts() {
    const accounts = [];
    let lastAccountId = 0;
    let lastSort = null;

    while (true) {
      const params = { size: 30 };
      if (lastAccountId) params.accountId = lastAccountId;
      if (lastSort !== null) params.lastSort = lastSort;

      const body = await this._get('/account/list', params);
      if (!body || body.code !== 200 || !Array.isArray(body.data)) break;

      const page = body.data;
      accounts.push(...page);

      if (page.length < 30) break;

      const last = page[page.length - 1];
      lastAccountId = last.accountId;
      lastSort = last.sort;
    }

    return accounts;
  }

  // ---------------------------------------------------------------------------
  // Emails
  // ---------------------------------------------------------------------------

  /**
   * Fetch a page of emails.
   *
   * @param {Object} opts
   * @param {number}  opts.type       0 = received (INBOX), 1 = sent
   * @param {number}  [opts.accountId]
   * @param {number}  [opts.size=50]
   * @param {number}  [opts.emailId]  Cursor: fetch emails with emailId < this value
   * @param {number}  [opts.allReceive=1] 1 = ignore accountId filter
   * @returns {Promise<{list: Array, total: number, latestEmail: Object}>}
   */
  async listEmails({ type, accountId, size = 50, emailId, allReceive = 1 } = {}) {
    const params = { type, size, allReceive };
    if (accountId != null) params.accountId = accountId;
    if (emailId != null) params.emailId = emailId;

    const body = await this._get('/email/list', params);
    if (!body || body.code !== 200) {
      throw new Error('listEmails failed: ' + JSON.stringify(body));
    }
    return body.data; // { list, total, latestEmail }
  }

  /**
   * Fetch ALL emails of a given type by paginating through the API.
   *
   * @param {number} type  0 = received, 1 = sent
   * @param {number} [limit=500]  Safety cap on the total number of emails fetched
   * @returns {Promise<Array>} All email objects, newest first
   */
  async fetchAllEmails(type, limit = 500) {
    const all = [];
    let cursorId = null; // null = start from the newest

    while (all.length < limit) {
      const remaining = limit - all.length;
      const size = Math.min(50, remaining);
      const params = { type, size, allReceive: 1 };
      if (cursorId != null) params.emailId = cursorId;

      const body = await this._get('/email/list', params);
      if (!body || body.code !== 200) break;

      const { list } = body.data;
      if (!list || list.length === 0) break;

      all.push(...list);

      if (list.length < size) break; // last page

      // The API returns emails sorted by emailId DESC (newest first)
      // Next cursor: the smallest emailId we've seen so far
      cursorId = list[list.length - 1].emailId;
    }

    return all;
  }

  /**
   * Permanently delete emails by ID.
   * @param {number[]} emailIds
   */
  async deleteEmails(emailIds) {
    if (!emailIds || emailIds.length === 0) return;
    await this._delete('/email/delete', { emailIds: emailIds.join(',') });
  }

  /**
   * Mark emails as read.
   * @param {number[]} emailIds
   */
  async markRead(emailIds) {
    if (!emailIds || emailIds.length === 0) return;
    await this._put('/email/read', { emailIds });
  }

  /**
   * Send an email via cloud-mail.
   *
   * @param {Object} params
   * @param {number}   params.accountId     Sending account ID
   * @param {string}   [params.name]        Sender display name
   * @param {string[]} params.receiveEmail  Recipient email addresses
   * @param {string}   params.subject       Subject
   * @param {string}   [params.text]        Plain-text body
   * @param {string}   [params.content]     HTML body
   * @param {Array}    [params.attachments] Attachments
   * @returns {Promise<Object>} Sent email object
   */
  async sendEmail(params) {
    const body = await this._post('/email/send', params);
    if (!body || body.code !== 200) {
      throw new Error('sendEmail failed: ' + JSON.stringify(body));
    }
    return body.data;
  }
}

module.exports = CloudMailClient;
