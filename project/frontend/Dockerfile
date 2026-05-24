FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.d/ /docker-entrypoint.d/
RUN apk add --no-cache jq
RUN chmod +x /docker-entrypoint.d/99-runtime-config.sh
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
