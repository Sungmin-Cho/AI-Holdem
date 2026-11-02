#!/bin/sh
# Copy this machine's Tailscale HTTPS certificate to where the AI Holdem listeners read it
# (--remote-tls-cert / --remote-tls-key, and --tls-cert / --tls-key if the participant port uses
# HTTPS). Run it once by hand, then daily from launchd.
#
#   renew-tailscale-cert.sh <MagicDNS name> <directory>
#   e.g. renew-tailscale-cert.sh mini.tail1234.ts.net "$HOME/holdem-tls"
#
# - One `tailscale cert` call returns the certificate and the key together on stdout, so the pair
#   always belongs together, and the sandboxed App Store CLI never writes into its own container.
# - Each part must parse and the two public keys must be equal before anything is replaced;
#   unchanged files are left alone. One run at a time per directory (a lock directory).
# - When a renewal is due, tailscaled starts it in the background and a later call hands out the
#   new pair: a daily run picks it up long before expiry. The running app reloads a changed pair
#   within ten minutes, without a restart.
#
# Exit status: 0 updated or unchanged, 1 nothing replaced (CLI or pair failure), 2 usage,
# 75 another run holds the lock.
set -eu
TS="${TAILSCALE:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
OPENSSL="${OPENSSL:-/usr/bin/openssl}"
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <MagicDNS name> <directory>" >&2
  exit 2
fi
name=$1
dir=$2
umask 077
mkdir -p "$dir"
lock="$dir/.renew.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # A run that was killed leaves its lock; a real run takes seconds.
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] && rm -rf "$lock" && mkdir "$lock" 2>/dev/null; then
    :
  else
    echo "another renewal is running ($lock)" >&2
    exit 75
  fi
fi
tmp=""
trap '[ -n "$tmp" ] && rm -rf "$tmp"; rmdir "$lock" 2>/dev/null' EXIT
tmp=$(mktemp -d "$dir/.renew.XXXXXX")
fail() {
  echo "$1; nothing replaced" >&2
  exit 1
}
"$TS" cert --cert-file - --key-file - "$name" > "$tmp/both.pem" || fail "tailscale cert failed"
awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' "$tmp/both.pem" > "$tmp/host.crt"
awk '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/' "$tmp/both.pem" > "$tmp/host.key"
[ -s "$tmp/host.crt" ] && [ -s "$tmp/host.key" ] || fail "tailscale cert returned no certificate or key"
# Separate commands, each checked: a pipeline would report only its last stage, and two parse
# failures would then compare equal.
cert_pub=$("$OPENSSL" x509 -in "$tmp/host.crt" -noout -pubkey 2>/dev/null) || fail "certificate does not parse"
key_pub=$("$OPENSSL" pkey -in "$tmp/host.key" -pubout 2>/dev/null) || fail "key does not parse"
enddate=$("$OPENSSL" x509 -in "$tmp/host.crt" -noout -enddate 2>/dev/null) || fail "certificate has no expiry"
[ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ] || fail "certificate and key do not match"
if [ -f "$dir/host.crt" ] && [ -f "$dir/host.key" ] && cmp -s "$tmp/host.crt" "$dir/host.crt" && cmp -s "$tmp/host.key" "$dir/host.key"; then
  echo "unchanged: $enddate"
  exit 0
fi
chmod 644 "$tmp/host.crt"
chmod 600 "$tmp/host.key"
# Key first: the app ignores a half-replaced pair (it does not load) and takes it on the next check.
mv "$tmp/host.key" "$dir/host.key"
mv "$tmp/host.crt" "$dir/host.crt"
echo "updated: $enddate"
