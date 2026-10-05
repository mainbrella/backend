FROM golang:1-trixie
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash tmux git openssh-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
RUN printf 'set -g default-shell /bin/bash\nset -g history-limit 2000\n' > /etc/tmux.conf
CMD ["sleep", "infinity"]
