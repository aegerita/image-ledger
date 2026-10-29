import { randomBytes } from 'node:crypto';

const SHORT_ID = /^[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createImageId(): string {
  return randomBytes(6).toString('hex');
}

export function isLegacyImageId(value: string): boolean {
  return value.length === 36 && UUID.test(value);
}

export function isImageId(value: unknown): value is string {
  return typeof value === 'string'
    && ((value.length === 12 && SHORT_ID.test(value)) || isLegacyImageId(value));
}
