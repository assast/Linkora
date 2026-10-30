#!/bin/sh
set -eu
node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
exec node dist/main.js
