# For the bounded Mainbrella custom-image builder: mainbrella is replaced with
# the pinned managed base. This recipe is source only, not a published catalog.
FROM mainbrella:base
RUN apt-get update && apt-get install -y --no-install-recommends python3 xvfb x11-utils xdotool imagemagick openbox xterm fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
