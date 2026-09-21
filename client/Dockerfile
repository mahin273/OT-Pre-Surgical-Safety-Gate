FROM node:22-alpine

WORKDIR /app

# Copy root monorepo manifests and client manifest
COPY package.json package-lock.json ./
COPY client/package.json ./client/

# Install client dependencies in workspace
RUN npm ci --workspace=client

# Copy client application code
COPY client ./client

WORKDIR /app/client

EXPOSE 3002

# Run Vite dev server bound to all interfaces
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "3002"]
