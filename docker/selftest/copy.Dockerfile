# Контрольний «поганий» образ для demo:image: COPY + rm — файла в фінальній ФС нема,
# а байти лежать у попередньому шарі.
FROM node:22-slim
COPY npm_token /tmp/npm_token
RUN test -s /tmp/npm_token && rm /tmp/npm_token
