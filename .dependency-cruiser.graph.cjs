const config = require("./.dependency-cruiser.cjs");

module.exports = {
  ...config,
  options: {
    ...config.options,
    tsPreCompilationDeps: false,
  },
};
