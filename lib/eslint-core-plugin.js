"use strict";

const { builtinRules } = require("eslint-compat/use-at-your-own-risk");

module.exports = {
  meta: {
    name: "@rustwrap/eslint-core",
    version: require("eslint-compat/package.json").version,
  },
  rules: Object.fromEntries(builtinRules),
};
