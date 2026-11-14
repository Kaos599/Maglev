#!/usr/bin/env bash
# Builds Maglev's self-hosted F-Droid repo from GitHub release APKs and writes it to $1 (for example _site/fdroid/repo).
#
# Users add https://kaos599.github.io/Maglev/fdroid/repo in F-Droid, Droid-ify or Neo Store and get updates.
# Only the split APKs go in (arm64-v8a, armeabi-v7a, x86_64). Their versionCodes end in the ABI digit
# (plugins/withAbiSplits.js), so each phone picks its own ABI. The universal APK (digit 0) stays out: it is the
# largest file and no phone needs it here.
#
# Env: FDROID_KEYSTORE_B64 (base64 PKCS12), FDROID_KEYSTORE_PASS, FDROID_KEY_ALIAS, GH_TOKEN, GITHUB_REPOSITORY,
#      ANDROID_HOME (apksigner), KEEP_RELEASES (default 5).
# The keystore signs the repo index only; APKs keep the app's own signature. config.yml and the keystore live in
# a temp folder and are never copied to the output.
set -euo pipefail

OUT="${1:?usage: build-fdroid-repo.sh <output dir>}"
# Absolute now: the script cd's into a temp folder below, and a relative path would land there and be deleted.
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"
KEEP_RELEASES=${KEEP_RELEASES:-5}
REPO="${GITHUB_REPOSITORY:-Kaos599/Maglev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LISTING="$ROOT/fastlane/metadata/android/en-US"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

: "${FDROID_KEYSTORE_B64:?missing}" "${FDROID_KEYSTORE_PASS:?missing}" "${FDROID_KEY_ALIAS:?missing}"

python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install --quiet "fdroidserver==2.4.5"

cd "$WORK"
mkdir -p repo/icons metadata/com.maglev
printf '%s' "$FDROID_KEYSTORE_B64" | base64 -d > keystore.p12

# Single-quoted YAML values; a quote inside the passphrase is doubled per YAML rules.
yq() { printf "'%s'" "${1//\'/\'\'}"; }
umask 077
cat > config.yml <<EOF
repo_url: https://kaos599.github.io/Maglev/fdroid/repo
repo_name: Maglev
repo_description: Official Maglev releases, built from github.com/${REPO}. Same APKs and signature as GitHub Releases.
repo_icon: icon.png
archive_older: 0
sdk_path: ${ANDROID_HOME:-/usr/local/lib/android/sdk}
keystore: keystore.p12
repo_keyalias: $(yq "$FDROID_KEY_ALIAS")
keystorepass: $(yq "$FDROID_KEYSTORE_PASS")
keypass: $(yq "$FDROID_KEYSTORE_PASS")
keydname: CN=Maglev F-Droid repo
EOF
umask 022

# fdroid resolves repo_icon against the working folder and copies it to repo/icons/icon.png itself
# (fdroidserver index.py); a file placed only in repo/icons/ is replaced by a QR placeholder.
cp "$LISTING/images/icon.png" icon.png
cp -R "$LISTING" metadata/com.maglev/en-US
cat > metadata/com.maglev.yml <<EOF
Categories:
  - Internet
  - Multimedia
License: GPL-3.0-only
AuthorName: Kaos599
WebSite: https://kaos599.github.io/Maglev/
SourceCode: https://github.com/${REPO}
IssueTracker: https://github.com/${REPO}/issues
Changelog: https://github.com/${REPO}/releases
EOF

# Newest releases first; drafts excluded. Each must carry the three split APKs.
gh release list --repo "$REPO" --exclude-drafts --limit "$KEEP_RELEASES" --json tagName -q '.[].tagName' |
  while read -r tag; do
    gh release download "$tag" --repo "$REPO" --dir repo \
      --pattern '*-arm64-v8a.apk' --pattern '*-armeabi-v7a.apk' --pattern '*-x86_64.apk' --skip-existing ||
      echo "warning: $tag has no split APKs, skipped" >&2
  done

ls repo/*.apk >/dev/null 2>&1 || { echo "no APKs downloaded; refusing to publish an empty repo" >&2; exit 1; }

"$WORK/venv/bin/fdroid" update --use-date-from-apk

mkdir -p "$OUT"
cp -R "$WORK/repo/." "$OUT"
echo "F-Droid repo written to $OUT ($(ls "$OUT"/*.apk | wc -l | tr -d ' ') APKs)"
