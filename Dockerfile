FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
