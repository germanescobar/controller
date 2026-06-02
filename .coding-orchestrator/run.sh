#!/bin/bash
set -e

CLIENT_BASE_PORT="${CLIENT_BASE_PORT:-4500}"
API_BASE_PORT="${API_BASE_PORT:-3100}"
OFFSET="${PORT_OFFSET:-0}"

if ! [[ "$CLIENT_BASE_PORT" =~ ^[0-9]+$ ]]; then
  echo "CLIENT_BASE_PORT must be a number" >&2
  exit 1
fi

if ! [[ "$API_BASE_PORT" =~ ^[0-9]+$ ]]; then
  echo "API_BASE_PORT must be a number" >&2
  exit 1
fi

if ! [[ "$OFFSET" =~ ^[0-9]+$ ]]; then
  echo "PORT_OFFSET must be a number" >&2
  exit 1
fi

CLIENT_PORT=$((CLIENT_BASE_PORT + OFFSET))
API_PORT=$((API_BASE_PORT + OFFSET))

export PORT="$API_PORT"
export API_PORT="$API_PORT"
export VITE_API_PORT="$API_PORT"
export VITE_DEV_SERVER_PORT="$CLIENT_PORT"

npm run dev
