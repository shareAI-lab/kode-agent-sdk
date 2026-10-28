#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed. Install Node.js 20.18.1–20.x or 22.x–25.x."
    exit 1
fi

if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit((major >= 22 && major <= 25) || (major === 20 && (minor > 18 || (minor === 18 && patch >= 1))) ? 0 : 1)'; then
    echo "Node.js 20.18.1–20.x or 22.x–25.x is required."
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed. Install npm before continuing."
    exit 1
fi

echo "Installing locked dependencies..."
npm ci

echo "Building TypeScript..."
npm run build

echo "KODE SDK is ready. Run these commands from the repository root:"
echo "  npm run example:getting-started -- --mock  # Offline, no API key"
echo "  npm run example:getting-started           # Requires ANTHROPIC_API_KEY; calls a model"
echo "  npm run test:onboarding                  # Offline lifecycle checks"
echo "  npm run test:unit                        # Offline unit tests; PostgreSQL is opt-in"
echo "Documentation: docs/en/ or docs/zh-CN/"
