#!/bin/sh
set -e

# Only start Tailscale if TAILSCALE_AUTHKEY is provided
if [ -n "${TAILSCALE_AUTHKEY}" ]; then
  echo "Starting Tailscale daemon..."
  /app/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock &

  echo "Authenticating with Tailscale..."
  /app/tailscale up --authkey="${TAILSCALE_AUTHKEY}" --hostname=page-turner --advertise-tags=tag:fly &
else
  echo "Skipping Tailscale setup (no TAILSCALE_AUTHKEY provided)"
fi

echo "Starting Node app..."
node --import ./dist/server/instrument.js dist/server.js
