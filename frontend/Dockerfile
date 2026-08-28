# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy shared types first (referenced via path alias)
COPY ../shared /shared

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:1.27-alpine AS production

COPY --from=builder /app/dist/frontend/browser /usr/share/nginx/html

# Proxy /api requests to the NestJS API service
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
