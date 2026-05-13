FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install && npm install tsx @supabase/supabase-js

COPY tsconfig*.json ./
COPY src/ ./src/
COPY engine/ ./engine/

EXPOSE 8080

CMD ["npx", "tsx", "src/server/index.ts"]
