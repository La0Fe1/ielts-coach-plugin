FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
EXPOSE 3000
CMD ["npm", "exec", "tsx", "--", "server/src/index.ts"]
