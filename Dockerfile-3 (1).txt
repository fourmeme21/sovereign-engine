FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig*.json ./
COPY sovereign-engine-main/src/ ./src/

EXPOSE 8080

CMD ["node", "--loader", "ts-node/esm", "src/server/index.ts"]
