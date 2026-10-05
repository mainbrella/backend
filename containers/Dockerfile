FROM node:24-trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash tmux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN printf 'set -g default-shell /bin/bash\nset -g history-limit 2000\n' > /etc/tmux.conf
WORKDIR /root
CMD ["sleep", "infinity"]
