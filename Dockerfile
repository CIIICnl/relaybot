FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/index.js"]
