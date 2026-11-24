FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY order.js ./
CMD ["node", "order.js", "/frames"]
