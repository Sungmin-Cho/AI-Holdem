#!/bin/sh
# Copy this machine's Tailscale HTTPS certificate chain and key into ONE file that the AI Holdem
# listeners read as both certificate and key:
#   --remote-tls-cert <dir>/host.pem --remote-tls-key <dir>/host.pem
#   (and --tls-cert / --tls-key the same, if the participant port uses HTTPS)
# Run it once by hand, then daily from launchd.
#
#   renew-tailscale-cert.sh <MagicDNS name> <directory>
#   e.g. renew-tailscale-cert.sh mini.tail1234.ts.net "$HOME/holdem-tls"
#
# - One `tailscale cert` call returns the chain and the key together on stdout, so they always
#   belong together, and the sandboxed App Store CLI never writes into its own container.
# - Every certificate of the chain and the one key must parse, and the key must match the leaf,
#   before anything is replaced; any other PEM block is refused, and the installed file is rebuilt
#   from the checked blocks only (certificates first, then the key). An unchanged file is left alone.
# - The new file replaces host.pem in one rename: a reader sees the old pair or the new one, never
#   a mix, and two runs at once each install a complete pair (the later one stays). A killed run
#   can leave a <dir>/.host.pem.XXXXXX temporary file (mode 600); it is safe to delete.
# - When a renewal is due, tailscaled starts it in the background and a later call hands out the
#   new pair: a daily run picks it up long before expiry. The running app reloads a changed file
#   within ten minutes, without a restart.
#
# Exit status: 0 updated or unchanged, 1 nothing replaced (CLI, parse or pair failure), 2 usage.
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
tmp=$(mktemp "$dir/.host.pem.XXXXXX")
out=$(mktemp "$dir/.host.pem.XXXXXX")
trap 'rm -f "$tmp" "$out"' EXIT
fail() {
  echo "$1; nothing replaced" >&2
  exit 1
}
"$TS" cert --cert-file - --key-file - "$name" > "$tmp" || fail "tailscale cert failed"
certs=$(grep -c -- '-----BEGIN CERTIFICATE-----' "$tmp" || true)
keys=$(grep -c -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$tmp" || true)
[ "$certs" -ge 1 ] && [ "$keys" -ge 1 ] || fail "tailscale cert returned no certificate or key"
[ "$keys" -eq 1 ] || fail "expected exactly one private key"
# Anything else (e.g. "X509 CERTIFICATE", which OpenSSL would also load as the leaf) is refused.
blocks=$(grep -c -- '-----BEGIN ' "$tmp" || true)
[ "$blocks" -eq $((certs + keys)) ] || fail "unexpected PEM block"
# Print the n-th certificate block (n from 1) or the key block of the file.
cert_block() { awk -v n="$1" '/-----BEGIN CERTIFICATE-----/ { i++ } i == n { print } /-----END CERTIFICATE-----/ && i == n { exit }' "$tmp"; }
key_block() { awk '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/' "$tmp"; }
# Each check ends in the openssl call, so its status is the parse result (`openssl x509` alone would
# read only the first certificate of a chain).
i=1
while [ "$i" -le "$certs" ]; do
  cert_block "$i" | "$OPENSSL" x509 -noout 2>/dev/null || fail "a certificate in the chain does not parse"
  i=$((i + 1))
done
cert_pub=$(cert_block 1 | "$OPENSSL" x509 -noout -pubkey 2>/dev/null) || fail "certificate does not parse"
key_pub=$(key_block | "$OPENSSL" pkey -pubout 2>/dev/null) || fail "key does not parse"
enddate=$(cert_block 1 | "$OPENSSL" x509 -noout -enddate 2>/dev/null) || fail "certificate has no expiry"
[ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ] || fail "certificate and key do not match"
# The file to install holds exactly the checked blocks.
i=1
while [ "$i" -le "$certs" ]; do
  cert_block "$i" >> "$out"
  i=$((i + 1))
done
key_block >> "$out"
if [ -d "$dir/host.pem" ]; then
  fail "$dir/host.pem is a directory"
fi
if [ -f "$dir/host.pem" ] && cmp -s "$out" "$dir/host.pem"; then
  echo "unchanged: $enddate"
  exit 0
fi
chmod 600 "$out"
mv "$out" "$dir/host.pem" || fail "could not replace host.pem"
echo "updated: $enddate"
