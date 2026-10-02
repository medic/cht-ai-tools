'use strict';
// The context object every stage receives.
const createContext = ({
  config, effective, policy, logger, runDir, runId, date, mode, tracer = null, engine = null, flags = {},
}) => ({
  config,
  effective,
  policy,
  logger,
  runDir,
  runId,
  date,
  mode,
  tracer,
  engine,
  flags,
  /** A child context bound to one stage: logger and tracer scoped to it. */
  forStage(stage) {
    return { ...this, stage, logger: logger.child({ stage }) };
  },
});

module.exports = { createContext };
