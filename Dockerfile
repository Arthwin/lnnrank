FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY wow-addons ./wow-addons
COPY test ./test
COPY .env.example ./.env.example
COPY README.md ./README.md
COPY AGENTS.md ./AGENTS.md
COPY REQUIREMENTS.md ./REQUIREMENTS.md

RUN mkdir -p /app/output/wow-addons /app/output/wow-addon-dashboard

EXPOSE 47832

CMD ["npm", "run", "wow-addon-dashboard"]

