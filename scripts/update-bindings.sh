#!/usr/bin/env bash
# Re-vendors @zephyr-ramp/escrow-client from a zephyr-contracts checkout.
#
# Usage: npm run bindings:update [-- ../zephyr-contracts]
#
# The client is vendored as a tarball so installs and CI work offline and
# without npm credentials. Once the package is published to npm, replace the
# `file:` dependency with a version range and delete vendor/.
set -euo pipefail
cd "$(dirname "$0")/.."
CONTRACTS="${1:-../zephyr-contracts}"
[[ -d "$CONTRACTS/bindings" ]] || { echo "No bindings/ in $CONTRACTS" >&2; exit 1; }

(cd "$CONTRACTS/bindings" && npm ci --no-audit --no-fund && npm run build)
rm -f vendor/zephyr-ramp-escrow-client-*.tgz
mkdir -p vendor
(cd "$CONTRACTS/bindings" && npm pack --pack-destination "$OLDPWD/vendor")
TARBALL="$(ls vendor/zephyr-ramp-escrow-client-*.tgz)"
npm install --no-audit --no-fund "./$TARBALL"
echo "Updated to $TARBALL"
