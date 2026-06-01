function defaultPanelFor(item) {
  return item.panel || item;
}

function xrayFirst(items, panelFor) {
  return items
    .map((item, index) => ({ item, index, panel: panelFor(item) }))
    .sort((first, second) => {
      const firstIsXray = first.panel?.proxy === 'xray';
      const secondIsXray = second.panel?.proxy === 'xray';
      if (firstIsXray === secondIsXray) return first.index - second.index;
      return firstIsXray ? -1 : 1;
    });
}

async function runWithRetry(panel, operation, retryCount) {
  const attempts = panel?.proxy === 'xray' ? retryCount + 1 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }

  if (attempts > 1) {
    throw new Error(`${lastError.message} after ${attempts} attempts`);
  }

  throw lastError;
}

export async function runPanelMutationsXrayFirst(items, mutate, options = {}) {
  const panelFor = options.panelFor || defaultPanelFor;
  const onError = options.onError || ((item, error) => ({ item, ok: false, error: error.message }));
  const onSkipped =
    options.onSkipped ||
    ((item, error) => ({ item, ok: false, skipped: true, error: `skipped after Xray failure: ${error.message}` }));
  const xrayRetries = Number.isInteger(options.xrayRetries) ? options.xrayRetries : 3;
  const results = new Array(items.length);
  let xrayFailure = null;

  for (const { item, index, panel } of xrayFirst(items, panelFor)) {
    if (xrayFailure) {
      results[index] = onSkipped(item, xrayFailure);
      continue;
    }

    try {
      results[index] = await runWithRetry(panel, () => mutate(item), xrayRetries);
    } catch (error) {
      results[index] = onError(item, error);
      if (panel?.proxy === 'xray') {
        xrayFailure = error;
      }
    }
  }

  return results;
}
