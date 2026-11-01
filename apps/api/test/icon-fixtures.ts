import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import type { IconHttpResponse, IconTransport } from '../src/site-icons';

export class FakeIconTransport implements IconTransport {
  readonly calls: { url: string; maxBytes: number; signal: AbortSignal }[] = [];
  constructor(private readonly handler: (url: URL, maxBytes: number, signal: AbortSignal, onBlocked?: () => void) => Promise<IconHttpResponse | null>) {}
  fetch(url: URL, maxBytes: number, signal: AbortSignal, onBlocked?: () => void) {
    this.calls.push({ url: url.href, maxBytes, signal });
    return this.handler(url, maxBytes, signal, onBlocked);
  }
}

export const realIcon = (format: 'png' | 'jpeg' | 'webp' = 'png', width = 32, height = 16) =>
  sharp({ create: { width, height, channels: 4, background: { r: 80, g: 120, b: 200, alpha: 0.5 } } }).toFormat(format).toBuffer();

export function animatedPngFixture() {
  const chunk = (name: string, data = Buffer.alloc(0)) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
  const frame = (sequence: number) => {
    const bytes = Buffer.alloc(26); bytes.writeUInt32BE(sequence); bytes.writeUInt32BE(1, 4); bytes.writeUInt32BE(1, 8);
    bytes.writeUInt16BE(1, 20); bytes.writeUInt16BE(10, 22); return bytes;
  };
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('acTL', animation), chunk('fcTL', frame(0)),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('fcTL', frame(1)), chunk('fdAT', Buffer.concat([sequence, deflateSync(Buffer.from([0, 0, 255, 0, 255]))])), chunk('IEND')]);
}

export async function untilIcon(predicate: () => boolean | Promise<boolean>, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('等待图标任务超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
