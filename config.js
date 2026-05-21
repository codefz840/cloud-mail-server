'use strict';

require('dotenv').config();

const config = {
  cloudMailUrl: (process.env.CLOUD_MAIL_URL || '').replace(/\/$/, ''),
  host: process.env.HOST || '0.0.0.0',
  imap: {
    port: parseInt(process.env.IMAP_PORT || '143', 10),
  },
  smtp: {
    port: parseInt(process.env.SMTP_PORT || '587', 10),
  },
};

if (!config.cloudMailUrl) {
  console.error('ERROR: CLOUD_MAIL_URL is not set. Please configure .env');
  process.exit(1);
}

module.exports = config;
