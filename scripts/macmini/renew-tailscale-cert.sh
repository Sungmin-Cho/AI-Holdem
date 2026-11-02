#!/bin/sh
# Copy this machine's Tailscale HTTPS certificate to where the AI Holdem remote host listener reads
# it (--remote-tls-cert / --remote-tls-key). Run it once by hand, then daily from launchd.
#
#   renew-tailscale-cert.sh <MagicDNS name> <directory>
#   e.g. renew-tailscale-cert.sh mini.tail1234.ts.net "$HOME/holdem-tls"
#
# - One `tailscale cert` call returns the certificate and the key together on stdout, so the pair
#   always belongs together, and the sandboxed App Store CLI never writes into its own container.
# - The pair is checked before anything is replaced; unchanged files are left alone.
# - tailscaled renews in the background once two thirds of the lifetime has passed and hands the
#   new pair out on a later call: a daily run picks it up long before expiry. The running app
#   reloads a changed pair within ten minutes, without a restart.
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
tmp=$(mktemp -d "$dir/.renew.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
"$TS" cert --cert-file - --key-file - "$name" > "$tmp/both.pem"
awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' "$tmp/both.pem" > "$tmp/host.crt"
awk '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/' "$tmp/both.pem" > "$tmp/host.key"
if [ ! -s "$tmp/host.crt" ] || [ ! -s "$tmp/host.key" ]; then
  echo "tailscale cert returned no certificate or key" >&2
  exit 1
fi
cert_pub=$("$OPENSSL" x509 -in "$tmp/host.crt" -noout -pubkey | "$OPENSSL" sha256)
key_pub=$("$OPENSSL" pkey -in "$tmp/host.key" -pubout | "$OPENSSL" sha256)
if [ "$cert_pub" != "$key_pub" ]; then
  echo "certificate and key do not match; nothing replaced" >&2
  exit 1
fi
if [ -f "$dir/host.crt" ] && [ -f "$dir/host.key" ] && cmp -s "$tmp/host.crt" "$dir/host.crt" && cmp -s "$tmp/host.key" "$dir/host.key"; then
  echo "unchanged: $("$OPENSSL" x509 -in "$dir/host.crt" -noout -enddate)"
  exit 0
fi
chmod 644 "$tmp/host.crt"
chmod 600 "$tmp/host.key"
# Key first: the app ignores a half-replaced pair (it does not load) and takes it on the next check.
mv "$tmp/host.key" "$dir/host.key"
mv "$tmp/host.crt" "$dir/host.crt"
echo "updated: $("$OPENSSL" x509 -in "$dir/host.crt" -noout -enddate)"
