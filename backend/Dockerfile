FROM node:20-alpine
WORKDIR /usr/src/app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

EXPOSE 4000
ENV PORT=4000
CMD ["npm", "run", "start"]
