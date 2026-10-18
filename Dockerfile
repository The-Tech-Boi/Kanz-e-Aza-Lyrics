# The Admin edit watchdog (scripts/admin_edit_watchdog.js), run on Coolify.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts ./scripts
USER node
CMD ["node", "scripts/admin_edit_watchdog.js"]
