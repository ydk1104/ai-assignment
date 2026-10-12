# ---------- build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- test stage ----------
# docker-compose.test.yml 의 test 서비스가 사용한다. 빌드 결과(dist), devDependencies, 테스트 코드를 모두 포함한다.
# 마지막 스테이지가 아니므로 기본 빌드(운영 이미지)에는 영향이 없다.
FROM builder AS test
ENV NODE_ENV=development
CMD ["node", "test/run.js"]

# ---------- production deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- runtime stage ----------
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
USER node
EXPOSE 3000
# 기본은 API 서버. 워커는 compose에서 command로 덮어씀
CMD ["node", "dist/main.js"]
