FROM node:22

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set strict-ssl false \
  && npm install --omit=dev --no-audit --no-fund \
  && npm install -g wrangler@4.38.0 \
  && npm config delete strict-ssl

COPY . .

EXPOSE 8787

CMD ["wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787"]
