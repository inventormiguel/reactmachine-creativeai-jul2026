FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json requirements.txt ./
RUN npm ci

RUN python3 -m venv /opt/reaction-venv \
    && /opt/reaction-venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH="/opt/reaction-venv/bin:${PATH}"

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "run", "start:railway"]
