# Контрольний «поганий» образ для demo:image: токен через ARG осідає в docker history.
FROM node:22-slim
ARG NPM_TOKEN
RUN test -n "$NPM_TOKEN"
