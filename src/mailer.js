import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';

/**
 * MAIL_MODE=smtp: sends through the configured SMTP relay.
 * MAIL_MODE=log:  sends nothing; writes each message to MAIL_OUTBOX_DIR as .eml and .html for checking.
 */
export function createMailer(mail) {
  if (mail.mode === 'smtp') {
    const { host, port, secure, user, pass } = mail.smtp;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      requireTLS: !secure,
    });
    return {
      mode: 'smtp',
      async send(message) {
        const info = await transport.sendMail({ from: mail.from, ...message });
        return { messageId: info.messageId };
      },
    };
  }

  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  return {
    mode: 'log',
    async send(message) {
      const info = await transport.sendMail({ from: mail.from || 'purchase-orders@localhost', ...message });
      await fs.mkdir(mail.outboxDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = String(message.subject || 'email')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
      const base = path.join(mail.outboxDir, `${stamp}-${slug}`);
      await fs.writeFile(`${base}.eml`, info.message);
      if (message.html) await fs.writeFile(`${base}.html`, message.html);
      // Attachments (the PO's PDF and CSV) are also saved next to the email so they're easy to open.
      for (const a of message.attachments || []) {
        const safe = String(a.filename || 'attachment').replace(/[^A-Za-z0-9._-]+/g, '_');
        await fs.writeFile(`${base}-${safe}`, a.content);
      }
      console.log(`[mail:log] "${message.subject}" to ${message.to} written to ${base}.eml`);
      return { messageId: info.messageId, file: `${base}.eml` };
    },
  };
}
