// Vendored from agent-hub-accounts (MIT), verbatim — see
// THIRD_PARTY_NOTICES.md and docs/decisions/2026-08-26-vendor-agent-hub-accounts.md.

import { AccountStateError } from './support/files';

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(label: string): AccountStateError {
  return new AccountStateError(`${label} is invalid`, 'ACCOUNT_INPUT');
}

export function providerId(value: unknown, label = 'provider'): string {
  const normalized = String(value ?? '').trim();
  if (!PROVIDER_ID_PATTERN.test(normalized) || RESERVED_KEYS.has(normalized)) throw invalid(label);
  return normalized;
}

export function accountId(value: unknown, label = 'account ID'): string {
  const normalized = String(value ?? '').trim();
  const isEmail = normalized.length <= 254 && EMAIL_PATTERN.test(normalized);
  const isOpaqueId = ACCOUNT_ID_PATTERN.test(normalized);
  if ((!isEmail && !isOpaqueId) || RESERVED_KEYS.has(normalized)) throw invalid(label);
  return normalized;
}
