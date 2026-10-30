# SynCareX PWA. Stage 1 builds the production bundle; stage 2 serves it with
# nginx, which also reverse-proxies /api and /health to the backend so the
# whole deployment is same-origin (the SameSite=Strict session cookie and the
# service worker both require this).
FROM node:24-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# The API base stays at its default ("/api/v1", relative): nginx maps it to
# the backend container. Set VITE_API_BASE_URL here only if you serve the
# API from somewhere other than the same origin.
RUN npm run build

FROM nginx:1.27-alpine

COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
