FROM node:20-alpine
WORKDIR /usr/src/app

# build arg for Vite env
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build the app (Vite will pick up VITE_BACKEND_URL)
RUN npm run build

EXPOSE 5173
CMD ["sh", "-c", "npm run preview -- --host 0.0.0.0 --port 5173"]
