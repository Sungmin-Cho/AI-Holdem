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
# - Every certificate in the chain and the key must parse, and the key must match the leaf, before
#   anything is replaced; unchanged files are left alone. If replacing fails half way, the previous
#   pair is put back.
# - One run at a time per directory: an flock on <directory>/.renew.lock held by the run and the
#   processes it starts, released by the kernel once they have all exited (however they end), so it
#   never needs taking over. `lsof <directory>/.renew.lock` lists the holders.
# - Working files live only in <directory>/.renew-work, which this script alone creates and clears.
# - When a renewal is due, tailscaled starts it in the background and a later call hands out the
#   new pair: a daily run picks it up long before expiry. The running app reloads a changed pair
#   within ten minutes, without a restart.
#
# Exit status: 0 updated or unchanged, 1 nothing replaced (CLI, parse, pair or replace failure),
# 2 usage, 75 another run holds the lock.
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
lockfile="$dir/.renew.lock"
# Only a run that holds the lock knows the token written into the lock file after it locked it;
# anything else (including a stray environment variable) goes through the lock.
if [ -z "${HOLDEM_RENEW_TOKEN:-}" ] || [ "$(cat "$lockfile" 2>/dev/null)" != "$HOLDEM_RENEW_TOKEN" ]; then
  # Re-run this script under an exclusive, non-blocking flock that the exec'd shell inherits.
  exec perl -e '
    $^F = 255;  # keep the lock descriptor open across exec
    open(my $lock, "+>>", shift) or die "cannot open the lock: $!\n";
    flock($lock, 6) or do { print STDERR "another renewal is running\n"; exit 75 };  # LOCK_EX|LOCK_NB
    my $token = sprintf("%d-%d-%08x%08x", $$, time, int(rand(2**32)), int(rand(2**32)));
    truncate($lock, 0); seek($lock, 0, 0); print $lock $token; $lock->flush;
    $ENV{HOLDEM_RENEW_TOKEN} = $token;
    exec @ARGV or die "cannot run the renewal: $!\n";
  ' "$lockfile" /bin/sh "$0" "$@"
fi
# Holding the lock, no other run is active: clear what a killed run left (it may hold a key copy).
# Only this script's own working directory is ever removed.
work="$dir/.renew-work"
rm -rf "$work"
mkdir "$work"
tmp="$work"
trap 'rm -rf "$work"; : > "$lockfile"' EXIT
fail() {
  echo "$1; nothing replaced" >&2
  exit 1
}
"$TS" cert --cert-file - --key-file - "$name" > "$tmp/both.pem" || fail "tailscale cert failed"
awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' "$tmp/both.pem" > "$tmp/host.crt"
awk '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/' "$tmp/both.pem" > "$tmp/host.key"
[ -s "$tmp/host.crt" ] && [ -s "$tmp/host.key" ] || fail "tailscale cert returned no certificate or key"
[ "$(grep -c -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$tmp/host.key")" -eq 1 ] || fail "expected exactly one private key"
# Each certificate of the chain on its own: openssl x509 reads only the first one of a file.
awk -v out="$tmp/chain" '/-----BEGIN CERTIFICATE-----/ { n++; f = sprintf("%s-%d.pem", out, n) } f { print > f } /-----END CERTIFICATE-----/ { close(f); f = "" }' "$tmp/host.crt"
for part in "$tmp"/chain-*.pem; do
  "$OPENSSL" x509 -in "$part" -noout 2>/dev/null || fail "a certificate in the chain does not parse"
done
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
had_key=""
if [ -f "$dir/host.key" ]; then
  cp -p "$dir/host.key" "$tmp/previous.key"
  had_key=1
fi
# Key first: the app ignores a half-replaced pair (it does not load) and takes it on the next check.
mv "$tmp/host.key" "$dir/host.key" || fail "could not replace the key"
if ! mv "$tmp/host.crt" "$dir/host.crt"; then
  if [ -n "$had_key" ] && mv "$tmp/previous.key" "$dir/host.key"; then
    fail "could not replace the certificate; the previous key was put back"
  fi
  # Keep the previous key out of the working directory so cleanup cannot take it.
  if [ -n "$had_key" ] && cp -p "$tmp/previous.key" "$dir/host.key.previous"; then
    echo "could not replace the certificate, and the previous key could not be put back: $dir holds a mismatched pair; the previous key is kept at $dir/host.key.previous" >&2
  else
    echo "could not replace the certificate, and the previous key could not be put back: $dir holds a mismatched pair" >&2
  fi
  exit 1
fi
echo "updated: $enddate"
