# Recommendation Service dùng root context vì cần tsconfig.base.json và packages/common.
# Dockerfile.dockerignore giới hạn context để không đưa service khác, cache local hoặc
# secret vào quá trình build.

# -----------------------------------------------------------------------------
# Giai đoạn build: cài dependency theo lockfile và biên dịch TypeScript.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifest trước source để Docker cache tốt hơn khi chỉ thay đổi mã nguồn.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/recommendation-service/package.json \
  services/recommendation-service/tsconfig.json \
  services/recommendation-service/tsconfig.build.json \
  services/recommendation-service/nest-cli.json \
  ./services/recommendation-service/

# npm ci bảo đảm dependency trong image đúng với package-lock của monorepo.
# Giữ devDependency ở builder vì Nest CLI và TypeScript cần cho bước compile.
RUN npm ci --workspace=services/recommendation-service --include=dev --ignore-scripts

# Chỉ copy source của Recommendation sau khi dependency đã được cache.
COPY services/recommendation-service/src ./services/recommendation-service/src

WORKDIR /app/services/recommendation-service
RUN npm run build

# Chuyển về root workspace trước khi prune vì npm quản lý dependency tại /app/node_modules.
WORKDIR /app

# Runtime không cần Nest CLI, Jest hoặc TypeScript.
RUN npm prune --omit=dev

# TypeScript giữ alias @common/* sau khi build; đặt artifact common vào vị trí
# Node.js có thể resolve mà không cần loader alias lúc runtime.
RUN mkdir -p node_modules/@common \
  && cp -R services/recommendation-service/dist/packages/common/. node_modules/@common/

# -----------------------------------------------------------------------------
# Giai đoạn runtime: image non-root, chỉ giữ dependency production và dist.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# Update Alpine packages so the runtime receives current security fixes.
RUN apk upgrade --no-cache

# npm/npx chỉ cần ở builder để cài dependency; runtime chỉ chạy bằng node.
# Loại chúng khỏi final image để không mang theo dependency/tooling không cần thiết của npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nestjs -u 1001

WORKDIR /app

# Copy node_modules của root workspace đã prune thay vì cài lại dependency lần hai.
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
# dist chứa Recommendation Service và artifact packages/common được compile cùng rootDir.
COPY --from=builder --chown=nestjs:nodejs /app/services/recommendation-service/dist ./dist

ENV NODE_ENV=production \
  PORT=3006 \
  NODE_OPTIONS=--max-old-space-size=128

EXPOSE 3006

# Health endpoint versioned xác nhận HTTP process còn sống; dependency downstream
# được kiểm tra trong response health và không làm container restart liên tục.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget --quiet --tries=1 --spider "http://localhost:${PORT}/api/v1/health" || exit 1

USER nestjs

# Chạy Node trực tiếp để nhận SIGTERM đúng khi Compose/Kubernetes rollout.
CMD ["node", "dist/services/recommendation-service/src/main.js"]
