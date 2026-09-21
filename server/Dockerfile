FROM node:22-alpine

# Install openssl for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Copy root monorepo manifests and server manifest
COPY package.json package-lock.json ./
COPY server/package.json ./server/

# Install server dependencies in workspace
RUN npm ci --workspace=server

# Copy server application code and prisma schema
COPY server ./server

WORKDIR /app/server

# Generate Prisma Client
RUN npx prisma generate

EXPOSE 4000

# Run migrations and start Express BFF with watch mode
CMD ["sh", "-c", "npx prisma migrate deploy && npm run dev"]
