# Build React frontend
FROM node:22-alpine AS frontend-build

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Build Node.js backend
FROM node:22-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./

# Copy compiled React frontend
COPY --from=frontend-build /frontend/dist ./public

ENV STATIC_DIR=/app/public

EXPOSE 3000

CMD ["npm", "start"]