#!/usr/bin/env node
"use strict";

const { realpathSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

// npm's extensionless bin link must bootstrap the standalone bundle itself.
const entryPoint = realpathSync(resolve(dirname(realpathSync(__filename)), "../dist/cli.cjs"));
process.argv[1] = entryPoint;
require(entryPoint);
