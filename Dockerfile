FROM node:14
COPY ["package.json", "yarn.lock", "tsconfig.json", "/project/"]
COPY ["src", "/project/src"]
RUN cd /project && yarn install --pure-lockfile && yarn cache clean --production && rm -r src

CMD node /project/lib/check-pr-action.js
