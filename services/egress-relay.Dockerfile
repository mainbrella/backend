FROM node:24-trixie-slim
WORKDIR /app
COPY services/egress-relay.mjs services/egress-relay-start.mjs ./services/
COPY containers/security-contract.js containers/file-contract.js ./containers/
USER node
EXPOSE 8081
CMD ["node", "services/egress-relay-start.mjs"]
