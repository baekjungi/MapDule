const MAX_REQUEST_BYTES = 16 * 1024;

async function readLimitedBody(request) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_REQUEST_BYTES) return { text: '', tooLarge: true };
  if (!request.body) return { text: '', tooLarge: false };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          console.error('Request body stream cancellation failed.');
        }
        return { text: '', tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
    return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}

module.exports = { readLimitedBody };
