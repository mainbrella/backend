FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
WORKDIR /app
COPY services/egress-relay.mjs services/egress-relay-start.mjs ./services/
COPY containers/security-contract.js containers/file-contract.js ./containers/
USER node
EXPOSE 8081
CMD ["node", "services/egress-relay-start.mjs"]
