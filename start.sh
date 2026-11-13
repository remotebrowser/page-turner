#!/bin/sh
set -e

# Only start Tailscale if TAILSCALE_AUTHKEY is provided
if [ -n "${TAILSCALE_AUTHKEY}" ]; then
  echo "Starting Tailscale daemon..."
  /app/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock &

  for _ in $(seq 1 20); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 0.5
  done

  # Block until connected so the first request does not race the tunnel.
  echo "Authenticating with Tailscale..."
  /app/tailscale up --authkey="${TAILSCALE_AUTHKEY}" --hostname=page-turner --advertise-tags=tag:fly --timeout=30s \
    || echo "Tailscale did not connect, starting the app anyway"
else
  echo "Skipping Tailscale setup (no TAILSCALE_AUTHKEY provided)"
fi

echo "Starting Node app..."
node --import ./dist/server/instrument.js dist/server.js
