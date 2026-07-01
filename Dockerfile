# Build stage - use Node.js to build both client and server
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage - use Node.js to run the Express server
FROM node:22-alpine AS runtime
WORKDIR /app

# Copy package files and install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copy the built application from builder stage
COPY --from=builder /app/dist ./dist

# Set production environment
ENV NODE_ENV=production
ENV PORT=3001

# Install Tailscale dependencies
RUN apk update && apk add --no-cache ca-certificates iptables ip6tables && rm -rf /var/cache/apk/*

# Copy Tailscale binaries from the tailscale image on Docker Hub
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscaled /app/tailscaled
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscale /app/tailscale

# Create Tailscale directories
RUN mkdir -p /var/run/tailscale /var/cache/tailscale /var/lib/tailscale

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Expose the application port
EXPOSE 3001

# Start the Express server
CMD ["/app/start.sh"] 
