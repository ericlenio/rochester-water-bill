/**
 * A small SMTP-over-implicit-TLS client. Enough to send one message, optionally
 * with an HTML alternative, through Gmail / Google Workspace on port 465, with
 * no dependencies. Promises only.
 */

import { connect } from 'node:tls';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

/**
 * Wrap a socket in a request/response session. SMTP replies can span several
 * lines; only a line whose code is followed by a space terminates one.
 */
const session = socket => {
  let buffer = '';
  let lines = [];
  const ready = [];
  const waiting = [];
  let failure = null;

  const deliver = reply => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(reply);
    else ready.push(reply);
  };

  const fail = error => {
    failure = error;
    while (waiting.length > 0) waiting.shift().reject(error);
  };

  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let index = buffer.indexOf(CRLF);
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        lines = [];
        deliver(reply);
      }
      index = buffer.indexOf(CRLF);
    }
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('SMTP connection closed unexpectedly.')));

  const next = () => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const reply = ready.shift();
    if (reply) { resolve(reply); return; }
    waiting.push({ resolve, reject });
  });

  /** Send a command (or nothing, to just read) and assert the reply code. */
  const command = (line, expected) => {
    if (line !== null) socket.write(line + CRLF);
    return next().then(reply => {
      if (!expected.includes(reply.code)) {
        const shown = line === null ? 'greeting' : line.split(' ')[0];
        throw new Error(`SMTP ${shown} failed: ${reply.text}`);
      }
      return reply;
    });
  };

  return { command, write: data => socket.write(data), end: () => socket.end() };
};

/** Fold base64 into the 76-character lines the MIME spec asks for. */
const fold = (text, width = 76) =>
  (text.match(new RegExp(`.{1,${width}}`, 'g')) || []).join(CRLF);

/** Non-ASCII in a header has to be encoded; keep it simple and correct. */
const encodeHeader = value => (/^[\x20-\x7e]*$/.test(value)
  ? value
  : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);

/** One base64 body part, headers included. */
const bodyPart = (type, content) => [
  `Content-Type: ${type}; charset=utf-8`,
  'Content-Transfer-Encoding: base64',
  '',
  fold(Buffer.from(content, 'utf8').toString('base64'))
];

/**
 * Build the message. Bodies are base64-encoded, which sidesteps both the
 * 998-character line limit and any need for dot-stuffing, and is invisible to
 * the reader either way.
 *
 * With `html`, the result is multipart/alternative. Parts go least-rich first:
 * a client renders the last one it understands, so text/plain has to precede
 * text/html.
 */
export const buildMessage = options => {
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: ${encodeHeader(options.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${options.from.split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0'
  ];

  if (!options.html) {
    return headers
      .concat(bodyPart('text/plain', options.text), '')
      .join(CRLF);
  }

  const boundary = `=_${randomUUID()}`;
  return headers
    .concat(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      'This is a multipart message in MIME format.',
      '',
      `--${boundary}`,
      bodyPart('text/plain', options.text),
      '',
      `--${boundary}`,
      bodyPart('text/html', options.html),
      '',
      `--${boundary}--`,
      '')
    .join(CRLF);
};

/**
 * Send one message. Resolves once the server has accepted it for delivery.
 */
export const sendMail = options => new Promise((resolve, reject) => {
  const socket = connect({
    host: options.host || 'smtp.gmail.com',
    port: options.port || 465,
    servername: options.host || 'smtp.gmail.com'
  });

  socket.setTimeout(30000, () => {
    socket.destroy(new Error('SMTP connection timed out.'));
  });
  socket.once('error', reject);

  socket.once('secureConnect', () => {
    const smtp = session(socket);
    const credentials = Buffer
      .from(`\0${options.user}\0${options.pass}`, 'utf8')
      .toString('base64');

    const message = buildMessage(options);

    smtp.command(null, [220])
      .then(() => smtp.command(`EHLO ${options.clientName || 'localhost'}`, [250]))
      .then(() => smtp.command(`AUTH PLAIN ${credentials}`, [235]))
      .then(() => smtp.command(`MAIL FROM:<${options.envelopeFrom || options.user}>`, [250]))
      .then(() => smtp.command(`RCPT TO:<${options.to}>`, [250, 251]))
      .then(() => smtp.command('DATA', [354]))
      .then(() => {
        smtp.write(message + CRLF + '.' + CRLF);
        return smtp.command(null, [250]);
      })
      .then(reply => {
        socket.removeListener('error', reject);
        smtp.end();
        resolve(reply.text);
      })
      .catch(error => {
        socket.removeListener('error', reject);
        socket.destroy();
        reject(error);
      });
  });
});
