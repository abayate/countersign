FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
