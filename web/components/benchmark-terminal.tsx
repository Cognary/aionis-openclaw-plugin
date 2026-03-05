"use client";

import { useEffect, useMemo, useState } from "react";

type Scenario = {
  caseId: string;
  baselineMs: number;
  replay1Ms: number;
  replay2Ms: number;
  playbookId: string;
};

const scenarios: Scenario[] = [
  { caseId: "17", baselineMs: 2356, replay1Ms: 210, replay2Ms: 150, playbookId: "pbk_7a31" },
  { caseId: "42", baselineMs: 2261, replay1Ms: 260, replay2Ms: 137, playbookId: "pbk_0f21" },
  { caseId: "82", baselineMs: 2334, replay1Ms: 364, replay2Ms: 118, playbookId: "pbk_5c89" },
  { caseId: "99", baselineMs: 2402, replay1Ms: 238, replay2Ms: 113, playbookId: "pbk_a19d" },
];

function getChipState(lineIndex: number, charIndex: number, targetLine: number, lineLen: number) {
  if (lineIndex < targetLine) return "pending";
  if (lineIndex === targetLine && charIndex < lineLen) return "running";
  return "pass";
}

export function BenchmarkTerminal() {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);

  const scenario = scenarios[scenarioIndex];
  const speedup = (scenario.baselineMs / scenario.replay2Ms).toFixed(2);
  const replayDeltaPct = (((scenario.replay1Ms - scenario.replay2Ms) / scenario.replay1Ms) * 100).toFixed(1);

  const lines = useMemo(
    () => [
      `$ openclaw aionis-memory replay bench --case ${scenario.caseId} --json`,
      `[baseline] status=success duration_ms=${scenario.baselineMs}`,
      `[compile] status=success playbook_id=${scenario.playbookId}`,
      `[replay1] status=success duration_ms=${scenario.replay1Ms}`,
      `[replay2] status=success duration_ms=${scenario.replay2Ms}`,
      `[delta] replay2_vs_baseline=${speedup}x replay2_vs_replay1=-${replayDeltaPct}%`,
      "result: compile=pass replay1=pass replay2=pass",
    ],
    [scenario.caseId, scenario.baselineMs, scenario.replay1Ms, scenario.replay2Ms, scenario.playbookId, speedup, replayDeltaPct],
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (lineIndex >= lines.length) {
      timer = setTimeout(() => {
        setScenarioIndex((prev) => (prev + 1) % scenarios.length);
        setLineIndex(0);
        setCharIndex(0);
      }, 1700);
      return () => clearTimeout(timer);
    }

    const currentLine = lines[lineIndex];
    if (charIndex < currentLine.length) {
      timer = setTimeout(() => setCharIndex((prev) => prev + 1), 22);
      return () => clearTimeout(timer);
    }

    timer = setTimeout(() => {
      setLineIndex((prev) => prev + 1);
      setCharIndex(0);
    }, 420);

    return () => clearTimeout(timer);
  }, [lineIndex, charIndex, lines]);

  const shownLines = lines.slice(0, lineIndex);
  const typingLine = lineIndex < lines.length ? lines[lineIndex].slice(0, charIndex) : "$ ";

  const compileState = getChipState(lineIndex, charIndex, 2, lines[2].length);
  const replay1State = getChipState(lineIndex, charIndex, 3, lines[3].length);
  const replay2State = getChipState(lineIndex, charIndex, 4, lines[4].length);

  return (
    <div className="demoTerminal benchTerminal">
      <div className="codeHead">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <strong>Replay Benchmark Terminal (simulated)</strong>
      </div>
      <div className="benchChips">
        <span className="benchChip" data-state={compileState}>compile</span>
        <span className="benchChip" data-state={replay1State}>replay1</span>
        <span className="benchChip" data-state={replay2State}>replay2</span>
      </div>
      <pre>
        {shownLines.map((line, idx) => (
          <span key={`${scenario.caseId}-${idx}`} className={`terminalLine ${line.startsWith("$") ? "lineCommand" : ""} ${line.includes("result:") ? "lineSuccess" : ""}`}>
            {line}
          </span>
        ))}
        <span className="terminalLine lineTyping">
          {typingLine}
          <i className="typingCursor">▋</i>
        </span>
      </pre>
      <div className="benchMeta">
        <span>case: {scenario.caseId}</span>
        <span>mode: strict</span>
        <span>dataset: workflow replay</span>
      </div>
    </div>
  );
}
