#!/bin/bash
# Read-only diagnostic: checks whether this shell session can actually decrypt
# the shared Antigravity Keychain item, and whether the agent-hub-accounts CLI
# commands that depend on it succeed from here.
#
# Run this from a normal Terminal.app window (NOT over SSH) — the whole point
# is to compare against the same commands failing when launched over SSH.
#
# Nothing here writes to the Keychain or switches any account.

set -u

pass() { printf '  \033[32mOK\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }

echo "== Session context =="
if [ -n "${SSH_TTY:-}${SSH_CONNECTION:-}" ]; then
  info "Running over SSH (SSH_TTY/SSH_CONNECTION set) — expected to fail below."
else
  info "Not an SSH session (this is what we want to test)."
fi
info "Console owner: $(stat -f '%Su' /dev/console 2>/dev/null || echo unknown)"
info "Current user: $(whoami)"
echo

echo "== Keychain item existence (no secret read) =="
if /usr/bin/security find-generic-password -s gemini -a antigravity >/tmp/keychain-exists.$$ 2>&1; then
  pass "item exists (service=gemini, account=antigravity)"
else
  fail "item does not exist or lookup failed"
fi
rm -f /tmp/keychain-exists.$$
echo

echo "== Keychain secret read (-w) — this is the call agent-hub-accounts makes =="
secret_len=$(/usr/bin/security find-generic-password -s gemini -a antigravity -w 2>/tmp/keychain-read-err.$$ | wc -c | tr -d ' ')
read_status=$?
if [ "$read_status" -eq 0 ] && [ "$secret_len" -gt 1 ]; then
  pass "secret read succeeded (${secret_len} bytes, not printing it)"
else
  fail "secret read failed (exit $read_status)"
  if [ -s /tmp/keychain-read-err.$$ ]; then
    info "stderr: $(cat /tmp/keychain-read-err.$$)"
  else
    info "no stderr output — typical of errSecInteractionNotAllowed in a non-GUI session"
  fi
fi
rm -f /tmp/keychain-read-err.$$
echo

CLI="${AGENT_HUB_ACCOUNTS_DIST:-$HOME/work/agent-hub-accounts/dist/cli.js}"
if [ -f "$CLI" ]; then
  echo "== agent-hub-accounts doctor (read-only) =="
  node "$CLI" doctor --json 2>&1 | head -c 1000
  echo
  echo

  echo "== agent-hub-accounts route --json (read-only, this is what the UI popup calls) =="
  node "$CLI" route --json 2>&1 | head -c 1000
  echo
else
  info "agent-hub-accounts CLI not found at $CLI, skipping CLI checks"
fi

echo
echo "== Done. Send the full output back. =="
