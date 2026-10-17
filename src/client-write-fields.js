function invalidField(field) {
  const error = new TypeError(`Client ${field} must contain a JSON array`);
  error.retryable = false;
  return error;
}

// ClientRecord stores these protocol fields as JSON text. The update endpoint
// accepts Client wire values, so forwarding the database strings is invalid.
export function clientWriteFields(client) {
  const result = { ...client };
  for (const field of ['allowedIPs', 'forwardedPorts']) {
    let value = result[field];
    if (typeof value === 'string') {
      if (!value.trim()) {
        // Older panel versions do not expose forwardedPorts in their write
        // schema. An empty database value carries no setting to preserve.
        if (field === 'forwardedPorts') { delete result[field]; continue; }
        value = [];
      } else {
        try { value = JSON.parse(value); } catch { throw invalidField(field); }
      }
    }
    if (value !== undefined && value !== null && !Array.isArray(value)) throw invalidField(field);
    if (field === 'allowedIPs' && Array.isArray(value) && value.some(ip => typeof ip !== 'string')) throw invalidField(field);
    if (value !== undefined) result[field] = value;
  }
  return result;
}
