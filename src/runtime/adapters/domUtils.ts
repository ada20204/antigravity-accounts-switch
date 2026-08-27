// Shared leaf-text-node + email matching, safety-critical (report-identity
// trusts it to pick which account's credentials to overwrite). See
// docs/decisions/email-leaf-matching-dedup.md for why this used to be three
// independently-drifting copies.

export const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function isLeafTextNode(el: HTMLElement): boolean {
  return el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE;
}

// Returns the trimmed email text if `el` is a leaf node whose entire text
// content is a syntactically valid email address, else null.
export function leafEmailText(el: HTMLElement): string | null {
  if (!isLeafTextNode(el)) return null;
  const text = el.textContent?.trim() ?? '';
  return EMAIL_PATTERN.test(text) ? text : null;
}

// accountPopup.ts/settingsEnhancer.ts build markup via innerHTML template
// strings rather than DOM APIs, so every daemon-sourced field interpolated
// into one (account name, plan label, issue text, id used in a data-*
// attribute) must go through this first — see
// docs/decisions/2026-08-26-unescaped-account-fields-in-innerhtml.md.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
