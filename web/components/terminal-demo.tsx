"use client";

import { motion } from "framer-motion";

const lines = [
  "$ openclaw plugins install @aionis/openclaw-aionis-memory",
  "$ agent.run \"install clawbot\"",
  "[trace] execution trace recorded",
  "[compile] playbook created: pbk_0f21",
  "[replay] strict mode passed",
  "[replay] guided mode available",
  "overall_status: pass",
];

export function TerminalDemo() {
  return (
    <div className="demoTerminal code-block">
      <div className="codeHead">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <strong>Agent Workflow Demo</strong>
      </div>
      <motion.pre
        initial="hidden"
        whileInView="show"
        viewport={{ once: true }}
        variants={{
          hidden: {},
          show: {
            transition: {
              staggerChildren: 0.1,
            },
          },
        }}
      >
        {lines.map((line, idx) => (
          <motion.span
            key={line}
            className={idx === lines.length - 1 ? "yes" : ""}
            variants={{
              hidden: { opacity: 0, x: -6 },
              show: { opacity: 1, x: 0 },
            }}
            transition={{ duration: 0.2 }}
          >
            {line}
          </motion.span>
        ))}
      </motion.pre>
    </div>
  );
}
