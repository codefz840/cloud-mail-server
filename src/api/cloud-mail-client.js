'use strict';

const axios = require('axios');
const API_PATH_SUFFIX = '/api';

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
    const hasApiSuffix = this.baseUrl.endsWith(API_PATH_SUFFIX);
    const hasBasePathBeforeApi = this.baseUrl !== API_PATH_SUFFIX;
    // Prefer modern worker routes under /api.
    this.apiBaseUrl = hasApiSuffix ? this.baseUrl : `${this.baseUrl}${API_PATH_SUFFIX}`;
    // Fallback for deployments exposing legacy root routes.
    if (hasApiSuffix && hasBasePathBeforeApi) {
      this.fallbackBaseUrl = this.baseUrl.slice(0, -API_PATH_SUFFIX.length);
    } else {
      this.fallbackBaseUrl = this.baseUrl;
    }
    this.fallbackEnabled = !hasApiSuffix && this.fallbackBaseUrl !== this.apiBaseUrl;
    this.token = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  _buildRequestError(requestDescription, error) {
    if (!error || typeof error !== 'object') {
      return new Error(`${requestDescription} failed`);
    }

    const parts = [];
    if (error.message) {
      parts.push(error.message);
    }

    const status = error.response && error.response.status;
    const statusCode = String(status);
    const mentionsStatus = Boolean(
      status &&
      error.message &&
      (
        error.message.includes(`HTTP ${statusCode}`) ||
        error.message.toLowerCase().includes(`status ${statusCode}`)
      )
    );
    if (status && !mentionsStatus) {
      parts.push(`status ${status}`);
    }

    const responseData = error.response && error.response.data;
    if (responseData !== undefined) {
      if (typeof responseData === 'string') {
        parts.push(responseData);
      } else {
        try {
          parts.push(JSON.stringify(responseData));
        } catch (_) {
          parts.push('[unserializable response body]');
        }
      }
    }

    return new Error(`${requestDescription} failed: ${parts.join(' | ') || 'request error'}`);
  }

  _shouldRetryWithFallback(error) {
    const status = error && error.response && error.response.status;
    return (status === 404 || status === 405) && this.fallbackEnabled;
  }

  async _request(method, path, { params, data, includeAuth = true } = {}) {
    const requestDescription = `${method.toUpperCase()} ${path}`;
    const makeRequest = async (baseUrl) => {
      const res = await axios({
        method,
        url: `${baseUrl}${path}`,
        headers: includeAuth ? this._authHeaders() : undefined,
        params,
        data,
      });
      // Cloud-mail responses use the API envelope shape { code, data, ... }.
      return res.data;
    };

    try {
      return await makeRequest(this.apiBaseUrl);
    } catch (error) {
      if (this._shouldRetryWithFallback(error)) {
        try {
          return await makeRequest(this.fallbackBaseUrl);
        } catch (fallbackError) {
          throw this._buildRequestError(requestDescription, fallbackError);
        }
      }

      throw this._buildRequestError(requestDescription, error);
    }
  }

  async _get(path, params = {}) {
    return this._request('get', path, { params });
  }

  async _post(path, data = {}) {
    return this._request('post', path, { data });
  }

  async _put(path, data = {}) {
    return this._request('put', path, { data });
  }

  async _delete(path, params = {}) {
    return this._request('delete', path, { params });
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
    const body = await this._request('post', '/login', {
      data: { email, password },
      includeAuth: false,
    });
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
   * @param {Object} [opts]
   * @param {number} [opts.accountId]
   * @param {number} [opts.allReceive] Defaults to 0 when accountId is provided, otherwise 1.
   * @returns {Promise<Array>} All email objects, newest first
   */
  async fetchAllEmails(type, limit = 500, opts = {}) {
    const { accountId, allReceive = accountId != null ? 0 : 1 } = opts;
    const all = [];
    let cursorId = null; // null = start from the newest

    while (all.length < limit) {
      const remaining = limit - all.length;
      const size = Math.min(50, remaining);
      const params = { type, size, allReceive };
      if (accountId != null) params.accountId = accountId;
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
