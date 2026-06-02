module.exports = {
  forbidden: [],
  options: {
    doNotFollow: { path: "node_modules" },
    reporterOptions: {
      dot: {
        theme: {
          graph: {
            concentrate: "true",
            rankdir: "LR",
            ranksep: "0.28",
            nodesep: "0.18",
            splines: "ortho",
          },
          edge: {
            arrowhead: "normal",
            arrowsize: "0.6",
            color: "#00000033",
            penwidth: "2.0",
          },
        },
      },
    },
    tsPreCompilationDeps: true,
  },
};
