export const NATIVE_RESPONSE_LIMIT = 512 * 1024;

export function nativeResponse(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') <= NATIVE_RESPONSE_LIMIT) return serialized;
  return JSON.stringify({ error: { code: 'OUTPUT_LIMIT', message: 'Native response exceeds 512 KiB; request a source window, smaller property page or a narrower source filter.' }, truncated: true, limitBytes: NATIVE_RESPONSE_LIMIT, originalBytes: Buffer.byteLength(serialized, 'utf8'), dataOmitted: true });
}
