FROM node:22

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set strict-ssl false \
  && npm install --omit=dev --no-audit --no-fund \
  && npm install -g wrangler@4.38.0 \
  && npm config delete strict-ssl

COPY . .

EXPOSE 8787

# wrangler dev reads local secrets from .dev.vars, so AUTH_SECRET is passed in
# as an environment variable and written out at startup:
#   docker run -p 8787:8787 -e AUTH_SECRET="a long random string" quotes-journal
CMD ["sh", "-c", "printf 'AUTH_SECRET=\"%s\"\\n' \"${AUTH_SECRET:?AUTH_SECRET must be set}\" > .dev.vars && exec wrangler dev --ip 0.0.0.0 --port 8787"]
