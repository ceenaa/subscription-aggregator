// One authenticated configuration per app. A generation prevents old in-flight
// reads from restoring a snapshot invalidated by an edit or settings change.
export function createSnapshotCache({ load, ttlMs = 20000, maxStaleMs = 120000, now = Date.now }) {
  let generation = 0;
  let currentKey;
  let value;
  let updatedAt = 0;
  let pending;
  let lastError = '';
  let retryAt = 0;
  let dirty = false;

  function invalidate({ keepValue = false } = {}) {
    generation += 1;
    if (!keepValue) {
      value = undefined;
      updatedAt = 0;
    }
    dirty = keepValue && value !== undefined;
    pending = undefined;
    lastError = '';
    retryAt = 0;
  }

  function refresh() {
    if (pending) return pending;
    const version = generation;
    const operation = Promise.resolve().then(load).then(data => {
      if (version === generation) {
        value = data;
        updatedAt = now();
        lastError = '';
        retryAt = 0;
        dirty = false;
      }
      return { data, updatedAt: now(), stale: false, refreshError: '' };
    }).catch(error => {
      if (version === generation) {
        lastError = error.message;
        retryAt = now() + Math.min(ttlMs, 5000);
      }
      throw error;
    }).finally(() => {
      if (version === generation) pending = undefined;
    });
    pending = operation;
    return operation;
  }

  return {
    invalidate,
    peek(key) {
      return key === currentKey && now() - updatedAt <= maxStaleMs ? value : undefined;
    },
    update(key, updater) {
      if (key !== currentKey || value === undefined || now() - updatedAt > maxStaleMs) return false;
      const updated = updater(value);
      invalidate({ keepValue: true });
      value = updated;
      return true;
    },
    async get(key, { force = false, wait = true } = {}) {
      if (key !== currentKey) {
        invalidate();
        currentKey = key;
      }
      const age = now() - updatedAt;
      if (value !== undefined && !force && age <= maxStaleMs) {
        if ((dirty || age >= ttlMs) && now() >= retryAt) refresh().catch(() => {});
        return { data: value, updatedAt, stale: dirty || age >= ttlMs, refreshError: lastError };
      }
      if (!force && !wait) {
        if (!pending && now() < retryAt) throw new Error(lastError);
        refresh().catch(() => {});
        return { loading: true };
      }
      return refresh();
    }
  };
}
