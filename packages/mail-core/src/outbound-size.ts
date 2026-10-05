// SPDX-License-Identifier: Apache-2.0
import type { OutboundEmail } from "./provider";

export const MAX_OUTBOUND_BYTES = 5 * 1024 * 1024;
// The structured binding adds MIME boundaries, Date/Message-ID, DKIM and other
// service headers. Keep headroom rather than measuring decoded attachment bytes.
const SERVICE_HEADER_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export class OutboundSizeError extends Error {
  constructor(readonly encodedBytes: number) {
    super("This message exceeds Cloudflare's 5 MiB total email limit after MIME encoding. Remove attachments or shorten the message and quoted history, then send again. Your draft has been kept.");
    this.name = "OutboundSizeError";
  }
}

/** RFC 2045 base64 plus CRLF folding (76 characters per line). */
export function base64WireBytes(byteLength: number): number {
  const characters = 4 * Math.ceil(byteLength / 3);
  return characters + 2 * Math.ceil(characters / 76);
}

function textPartBytes(text: string | undefined): number {
  if (!text) return 0;
  const bytes = encoder.encode(text);
  // The binding owns serialization. Budget both permitted transfer encodings:
  // quoted-printable escaping/folding can be larger than base64 for Unicode.
  let quotedPrintable = 0;
  for (const byte of bytes) {
    quotedPrintable += byte >= 33 && byte <= 126 && byte !== 61 ? 1 : 3;
  }
  quotedPrintable += 3 * Math.ceil(quotedPrintable / 73);
  return 256 + Math.max(base64WireBytes(bytes.byteLength), quotedPrintable);
}

function headerBytes(value: string): number {
  // Encoded-word/parameter escaping, wrappers and folding, not JS characters.
  return 64 + 3 * encoder.encode(value).byteLength;
}

/** Conservative complete wire budget for the structured builder, including
 * headers, both bodies, inline images, attachment base64 and MIME framing. */
export function outboundWireBytes(email: OutboundEmail): number {
  let total = SERVICE_HEADER_BYTES + headerBytes(email.subject)
    + headerBytes(email.from.email) + headerBytes(email.from.name ?? "");
  for (const address of [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])]) total += headerBytes(address);
  for (const [key, value] of Object.entries(email.headers ?? {})) total += headerBytes(`${key}: ${value}`);
  total += textPartBytes(email.text) + textPartBytes(email.html);
  for (const attachment of email.attachments ?? []) {
    total += 512 + headerBytes(attachment.filename) + headerBytes(attachment.contentType)
      + headerBytes(attachment.contentId ?? "") + base64WireBytes(attachment.content.byteLength);
  }
  return total;
}

export function assertOutboundSize(email: OutboundEmail): void {
  const size = outboundWireBytes(email);
  if (size > MAX_OUTBOUND_BYTES) throw new OutboundSizeError(size);
}
