# Single container: builds the web app and runs the Node server (serves UI + API on $PORT).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build
ENV PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
