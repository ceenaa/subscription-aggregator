export const INBOUNDS_SCRIPT = `(() => {
  function randomLabel(length = 8) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall back to the older copy command when browser permissions block Clipboard API.
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('copy command failed');
  }

  for (const box of document.querySelectorAll('[data-copy-text]')) {
    const hint = box.parentElement?.querySelector('[data-copy-hint]');
    const originalHint = hint?.textContent || '';
    const run = async () => {
      try {
        await copyText(box.dataset.copyText || box.textContent || '');
        box.dataset.copied = 'true';
        if (hint) hint.textContent = 'Copied';
        window.setTimeout(() => {
          delete box.dataset.copied;
          if (hint) hint.textContent = originalHint;
        }, 1800);
      } catch {
        if (hint) hint.textContent = 'Copy failed';
      }
    };

    box.addEventListener('click', run);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        run();
      }
    });
  }

  for (const button of document.querySelectorAll('[data-random-email]')) {
    button.addEventListener('click', () => {
      const input = button.closest('label')?.querySelector('input[name="email"]');
      if (!input) return;
      input.value = randomLabel();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
  }
})();`;
