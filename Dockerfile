FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig*.json ./
COPY sovereign-engine-main/ ./sovereign-engine-main/

RUN npm run build

EXPOSE 8080

CMD ["node", "dist/server/index.js"]
