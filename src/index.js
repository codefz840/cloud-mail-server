'use strict';

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
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await Promise.all([imapServer.close(), smtpServer.close()]);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
