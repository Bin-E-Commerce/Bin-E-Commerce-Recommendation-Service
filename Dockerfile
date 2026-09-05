# Dockerfile build Recommendation Service từ root context để đóng gói cả shared event contract.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/recommendation-service/package.json ./services/recommendation-service/
COPY services/recommendation-service/tsconfig.json services/recommendation-service/tsconfig.build.json services/recommendation-service/nest-cli.json ./services/recommendation-service/
COPY services/recommendation-service/src ./services/recommendation-service/src

RUN npm install --workspace=services/recommendation-service
WORKDIR /app/services/recommendation-service
RUN npm run build

FROM node:20-alpine AS production
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
WORKDIR /app

COPY services/recommendation-service/package.json ./package.json
RUN npm install --omit=dev
COPY --from=builder /app/services/recommendation-service/dist ./dist

ENV NODE_ENV=production
EXPOSE 3006
USER nestjs
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3006/api/v1/health || exit 1
CMD ["node", "--max-old-space-size=128", "dist/services/recommendation-service/src/main.js"]
