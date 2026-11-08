FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config
COPY public ./public
EXPOSE 3000
USER node
CMD ["npx", "tsx", "src/server.ts"]
