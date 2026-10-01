#!/usr/bin/env sh
# TOKEN NEXUS - Global Token Observatory (macOS / Linux launcher)
#
# ASCII-only on purpose, so it behaves the same under any locale.
# Usage:  ./start.sh            ./start.sh --port 8899 --no-open

set -e
cd "$(dirname "$0")"

echo ""
echo "  ======================================================"
echo "    T O K E N   N E X U S"
echo "    Global Token Observatory"
echo "  ======================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [x] Node.js not found."
  echo "      Install Node.js 22.15 or newer:  https://nodejs.org/"
  echo "      Then run this script again."
  echo ""
  exit 1
fi

NODE_VERSION=$(node -p "process.versions.node")
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
echo "  Node.js v$NODE_VERSION"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 15 ]; }; then
  echo "  [!] Version is a bit old: reading zstd session logs needs 22.15+."
  echo "      Those sources will be skipped, everything else still works."
fi
echo ""
echo "  Starting... first scan takes about 30 seconds."
echo "  The browser opens automatically at http://127.0.0.1:8787"
echo ""

exec node server.mjs "$@"
