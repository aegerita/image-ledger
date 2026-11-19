import { posix } from 'node:path';

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isManagedPath(value: string): boolean {
  const file = posix.parse(value);
  return isSha256(file.name) && ['.jpg', '.png'].includes(file.ext)
    && /(?:^|\/)images$/.test(file.dir);
}
