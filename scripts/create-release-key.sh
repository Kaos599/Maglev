#!/usr/bin/env bash
# Creates Maglev's release signing key and stores it in the repo's GitHub Actions secrets.
# Run it yourself in a normal Terminal (not through an AI assistant), once:
#
#   bash scripts/create-release-key.sh
#
# It prints the password ONCE at the end so you can save it, with the keystore file, in your
# password manager. Losing the keystore or its password means no future update can install
# over the current one, so keep both safe before you close the window.
set -euo pipefail

OUT="${HOME}/maglev-release.jks"
ALIAS="maglev"
REPO="Kaos599/Maglev"

if [ -e "$OUT" ]; then
  echo "$OUT already exists. Move it away first; this script never overwrites a key." >&2
  exit 1
fi
command -v keytool >/dev/null || { echo "keytool not found (install a JDK)." >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

# 32 random bytes, base64 without characters that confuse shells or Gradle.
PASS="$(openssl rand -base64 32 | tr -d '/+=\n' | cut -c1-40)"
export PASS

# PKCS12 keystore: the key and the store share one password.
keytool -genkeypair -v \
  -keystore "$OUT" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Maglev, O=Maglev" \
  -storepass:env PASS -keypass:env PASS >/dev/null 2>&1
chmod 600 "$OUT"

# Secrets go in through stdin, so they never appear in the process list or shell history.
base64 -i "$OUT" | tr -d '\n' | gh secret set MAGLEV_KEYSTORE_B64 --repo "$REPO"
printf '%s' "$PASS"  | gh secret set MAGLEV_KEYSTORE_PASSWORD --repo "$REPO"
printf '%s' "$PASS"  | gh secret set MAGLEV_KEY_PASSWORD --repo "$REPO"
printf '%s' "$ALIAS" | gh secret set MAGLEV_KEY_ALIAS --repo "$REPO"

SHA=$(keytool -list -v -keystore "$OUT" -alias "$ALIAS" -storepass:env PASS | sed -n 's/.*SHA256: //p' | head -1)

cat <<EOF

Done. Four secrets are set on $REPO.

Save these in Bitwarden now (one secure note, plus the file as an attachment):
  Keystore file : $OUT
  Alias         : $ALIAS
  Password      : $PASS   (store and key password are the same)
  SHA-256       : $SHA    (public; lets anyone check an APK is yours)

After saving, you can delete $OUT from this Mac (Bitwarden and GitHub keep it).
EOF
unset PASS
