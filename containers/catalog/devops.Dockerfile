FROM hashicorp/terraform:latest AS terraform
FROM public.ecr.aws/aws-cli/aws-cli:latest AS aws
FROM node:24-trixie-slim
COPY --from=terraform /bin/terraform /usr/local/bin/terraform
COPY --from=aws /usr/local/aws-cli /usr/local/aws-cli
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash tmux git openssh-client curl ca-certificates groff less \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws
RUN npm install -g wrangler
RUN printf 'set -g default-shell /bin/bash\nset -g history-limit 2000\n' > /etc/tmux.conf
WORKDIR /workspace
CMD ["sleep", "infinity"]
