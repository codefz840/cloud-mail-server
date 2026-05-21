'use strict';

// Prepend ISO timestamp to every console.log / console.error output.
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _ts = () => new Date().toISOString();
console.log   = (...args) => _origLog(_ts(), ...args);
console.error = (...args) => _origError(_ts(), ...args);

const config = require('../config');
const ImapServer = require('./imap/imap-server');
const SmtpBridgeServer = require('./smtp/smtp-server');

async function main() {
  const imapServer = new ImapServer(config.cloudMailUrl);
  const smtpServer = new SmtpBridgeServer(config.cloudMailUrl);

  await imapServer.listen(config.imap.port, config.host);
  await smtpServer.listen(config.smtp.port, config.host);

  console.log('cloud-mail-server started.');
  console.log(`  IMAP: ${config.host}:${config.imap.port}`);
  console.log(`  SMTP: ${config.host}:${config.smtp.port}`);
  console.log(`  cloud-mail API: ${config.cloudMailUrl}`);

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) {
      console.log(`\nReceived ${signal} again, forcing exit...`);
      process.exit(1);
      return;
    }

    isShuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      await Promise.all([imapServer.close(), smtpServer.close()]);
      process.exit(0);
    } catch (err) {
      console.error('Shutdown failed:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
