import type { ImageRecord } from './types';

/** Attach rejection handlers when staging begins, even if a caption dialog delays consumption. */
export function settledCaptures<T>(promises: Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(promises);
}

/** Render each image once, using its final caption after every dialog in this batch has finished. */
export function latestBatchRecords(records: ImageRecord[], latest: ImageRecord[]): ImageRecord[] {
  const current = new Map(latest.map(record => [record.id, record]));
  const seen = new Set<string>();
  return records.flatMap(record => {
    if (seen.has(record.id)) return [];
    seen.add(record.id);
    return [current.get(record.id) ?? record];
  });
}
