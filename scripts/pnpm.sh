#!/bin/sh

set -eu

if command -v pnpm >/dev/null 2>&1; then
  exec pnpm "$@"
fi

if command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec --yes --package=pnpm@10.13.1 -- pnpm "$@"
fi

printf '%s\n' \
  'NEXUS requires pnpm 10.13.1. Install Node.js with npm, Corepack, or pnpm.' >&2
exit 127
