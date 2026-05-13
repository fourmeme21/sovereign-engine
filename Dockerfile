FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install && npm install tsx

COPY tsconfig*.json ./
COPY src/ ./src/

EXPOSE 8080

CMD ["npx", "tsx", "src/server/index.ts"]
